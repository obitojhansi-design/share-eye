/* =========================================================
   js/webrtc.js
   ---------------------------------------------------------
   Host → guest screen sharing over WebRTC.

   Supabase Realtime is used ONLY as the signalling channel.
   The video and audio travel peer-to-peer.

   Audio
   -----
   `getDisplayMedia({ audio: true })` captures tab/system audio
   on Chrome and Edge desktop, when the user ticks the "Share tab
   audio" / "Share system audio" checkbox in the picker.

   It does NOT work on:
     • iOS Safari (any version)
     • Chrome on Android
     • Firefox for Android
   On those, the browser either throws or returns video-only.
   We retry with `audio: false` so sharing still works, and tell
   the user via `onStatus('live', { hasAudio: false })`.
   ========================================================= */

import { CONFIG } from './config.js';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 2,
};

export function isScreenShareSupported() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
    typeof window.RTCPeerConnection === 'function'
  );
}

/**
 * @param {object} options
 * @param {string} options.selfId
 * @param {(msg:object)=>void} options.sendSignal
 * @param {(stream:MediaStream, fromId:string)=>void} options.onStream
 * @param {(state:'live'|'stopped'|'lost', info?:object)=>void} options.onStatus
 */
export function createScreenShare({ selfId, sendSignal, onStream, onStatus }) {
  /** @type {Map<string, RTCPeerConnection>} */
  const peers = new Map();

  let localStream = null;
  let sharing = false;
  let hostId = null;

  /* ------------------------------------------------------------ helpers */

  function closePeer(peerId) {
    const pc = peers.get(peerId);
    if (!pc) return;
    try { pc.close(); } catch { /* ignore */ }
    peers.delete(peerId);
  }

  function closeAllPeers() {
    for (const id of [...peers.keys()]) closePeer(id);
  }

  /**
   * Apply per-track sender parameters: bitrate caps, framerate, and
   * degradation preference. Without these, WebRTC's defaults can send
   * far more than a phone on Wi-Fi can receive, which is the usual
   * cause of laggy screen share.
   */
  async function tuneSender(sender, track) {
    try {
      const params = sender.getParameters();

      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      if (track.kind === 'video') {
        params.encodings[0].maxBitrate = CONFIG.SCREEN_VIDEO_BITRATE;
        params.encodings[0].maxFramerate = CONFIG.SCREEN_MAX_FPS;
        params.encodings[0].networkPriority = 'high';
        params.degradationPreference = 'maintain-framerate';
      } else if (track.kind === 'audio') {
        params.encodings[0].maxBitrate = CONFIG.SCREEN_AUDIO_BITRATE;
        params.encodings[0].networkPriority = 'high';
      }

      await sender.setParameters(params);
    } catch (err) {
      // Not fatal — the browser just keeps its defaults.
      console.warn('[WEBRTC] Could not tune sender:', err);
    }
  }

  function makePeer(peerId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          to: peerId,
          kind: 'ice',
          data: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WEBRTC] peer ${peerId.slice(0, 8)} state:`, state);
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        onStatus?.('lost', { peerId });
        closePeer(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        `[WEBRTC] peer ${peerId.slice(0, 8)} ICE:`,
        pc.iceConnectionState
      );
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) onStream?.(stream, peerId);
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        const sender = pc.addTrack(track, localStream);
        tuneSender(sender, track);
      }
    }

    peers.set(peerId, pc);
    return pc;
  }

  /* --------------------------------------------------------- host: start */

  async function start() {
    if (sharing) return localStream;

    if (!isScreenShareSupported()) {
      throw new Error(
        'This browser cannot share the screen. Try Chrome or Edge on desktop.'
      );
    }

    let stream = null;

    // ---- First attempt: video + system audio.
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: CONFIG.SCREEN_MAX_FPS, max: 30 },
          width: { max: CONFIG.SCREEN_MAX_WIDTH },
          height: { max: CONFIG.SCREEN_MAX_HEIGHT },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
        },
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        throw new Error('Screen sharing was cancelled.');
      }
      console.warn('[WEBRTC] audio+video getDisplayMedia failed:', err);
      stream = null;
    }

    // ---- Second attempt: video only.
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: CONFIG.SCREEN_MAX_FPS, max: 30 },
            width: { max: CONFIG.SCREEN_MAX_WIDTH },
            height: { max: CONFIG.SCREEN_MAX_HEIGHT },
          },
          audio: false,
        });
      } catch (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
          throw new Error('Screen sharing was cancelled.');
        }
        if (err && err.name === 'NotSupportedError') {
          throw new Error('This device cannot share its screen.');
        }
        throw new Error('Screen sharing could not start.');
      }
    }

    // ---- Tell the encoder what kind of content this is.
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      try { videoTrack.contentHint = 'motion'; } catch { /* ignore */ }
      videoTrack.addEventListener('ended', () => {
        stop();
        onStatus?.('stopped');
      });
    }
    for (const audioTrack of stream.getAudioTracks()) {
      try { audioTrack.contentHint = 'music'; } catch { /* ignore */ }
    }

    localStream = stream;
    sharing = true;

    const hasAudio = stream.getAudioTracks().length > 0;
    console.log('[WEBRTC] Screen share started', {
      hasAudio,
      video: stream.getVideoTracks().length,
      audio: stream.getAudioTracks().length,
    });

    onStatus?.('live', { hasAudio });
    return stream;
  }

  /* --------------------------------------------------------- host: stop */

  function stop({ notify = true } = {}) {
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    localStream = null;
    sharing = false;
    closeAllPeers();

    if (notify) onStatus?.('stopped');
  }

  /* ------------------------------------- host: connect to a known guest */

  async function connectTo(peerId) {
    if (!sharing || !localStream) return;
    if (peers.has(peerId)) return;

    const pc = makePeer(peerId);

    try {
      const offer = await pc.createOffer({ offerToReceiveVideo: false });
      await pc.setLocalDescription(offer);
      sendSignal({
        to: peerId,
        kind: 'offer',
        data: { type: offer.type, sdp: offer.sdp },
      });
    } catch (err) {
      console.warn('[WEBRTC] Could not create offer:', err);
      closePeer(peerId);
    }
  }

  /* --------------------------------------------------- incoming signals */

  async function handleSignal(message) {
    if (!message || message.to !== selfId) return;

    const { from, kind, data } = message;

    if (kind === 'offer') {
      if (sharing) return;
      hostId = from;

      let pc = peers.get(from);
      if (pc) {
        try { pc.close(); } catch { /* ignore */ }
        peers.delete(from);
      }
      pc = makePeer(from);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({
          to: from,
          kind: 'answer',
          data: { type: answer.type, sdp: answer.sdp },
        });
      } catch (err) {
        console.warn('[WEBRTC] Could not answer offer:', err);
        closePeer(from);
      }
      return;
    }

    if (kind === 'answer') {
      const pc = peers.get(from);
      if (!pc) return;
      try {
        if (!pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data));
        }
      } catch { /* ignore */ }
      return;
    }

    if (kind === 'ice') {
      const pc = peers.get(from);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      } catch { /* candidates can arrive before the description */ }
    }
  }

  /* ---------------------------------------------------- guest cleanup */

  function onHostLeft() {
    closeAllPeers();
    onStream?.(null, hostId || '');
  }

  return {
    start,
    stop,
    connectTo,
    handleSignal,
    onHostLeft,
    closeAllPeers,

    get isSharing() { return sharing; },
    get stream() { return localStream; },

    destroy() {
      stop({ notify: false });
    },
  };
}