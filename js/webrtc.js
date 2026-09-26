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

   It does NOT work on iOS Safari, Chrome on Android, or Firefox
   for Android. On those, the browser either throws or returns
   video-only. We retry with `audio: false` so sharing still works,
   and tell the user via `onStatus('live', { hasAudio: false })`.

   Sender tuning
   -------------
   RTCRtpSender.setParameters() is only valid AFTER the peer
   connection has had setLocalDescription() called at least once.
   Calling it before negotiation leaves the encodings empty and
   the sender silently produces no RTP — the offer/answer succeeds,
   ICE completes, ontrack fires, and no frames ever arrive.

   So the tuning is deferred to immediately after setLocalDescription
   in connectTo().
   ========================================================= */

import { CONFIG } from './config.js';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

export function isScreenShareSupported() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
    typeof window.RTCPeerConnection === 'function'
  );
}

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
   * Tune a sender's encodings.
   *
   * Must only be called AFTER setLocalDescription() has run on the
   * peer connection, or the encodings will be empty and the sender
   * will never produce RTP.
   */
  async function tuneSender(sender, track) {
    if (!track) return;

    try {
      const params = sender.getParameters();

      // If the browser returned no encodings yet, we cannot set any.
      // Better to leave the sender with its defaults than to install
      // an empty encoding slot and silently drop all media.
      if (!params.encodings || params.encodings.length === 0) {
        console.log('[WEBRTC] tuneSender: no encoding slots yet for', track.kind);
        return;
      }

      if (track.kind === 'video') {
        params.encodings[0].maxBitrate = CONFIG.SCREEN_VIDEO_BITRATE;
        params.encodings[0].maxFramerate = CONFIG.SCREEN_MAX_FPS;
        params.degradationPreference = 'maintain-framerate';
      } else if (track.kind === 'audio') {
        params.encodings[0].maxBitrate = CONFIG.SCREEN_AUDIO_BITRATE;
      }

      await sender.setParameters(params);
      console.log('[WEBRTC] tuneSender ok:', track.kind, params.encodings[0]);
    } catch (err) {
      // Not fatal. The sender will use its default parameters.
      console.warn('[WEBRTC] tuneSender failed for', track.kind, err);
    }
  }

  async function tuneAllSenders(pc) {
    for (const sender of pc.getSenders()) {
      await tuneSender(sender, sender.track);
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
      console.log('[WEBRTC] ontrack fired on', peerId.slice(0, 8), {
        kind: event.track.kind,
        hasStream: !!stream,
      });
      if (stream) onStream?.(stream, peerId);
    };

    // Add tracks only. Do NOT tune senders here — tuning must wait
    // until after setLocalDescription.
    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
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

    // ---- First attempt: video + system audio, minimal constraints.
    // Let the browser choose the resolution and framerate; adding
    // constraints here is what trips OverconstrainedError on mobile.
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      console.log('[WEBRTC] getDisplayMedia ok (audio+video)');
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
          video: true,
          audio: false,
        });
        console.log('[WEBRTC] getDisplayMedia ok (video only)');
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

      // Now that the peer connection has a local description, the
      // sender encoding slots exist and setParameters is legal.
      await tuneAllSenders(pc);

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
      if (sharing) return; // only the host offers
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