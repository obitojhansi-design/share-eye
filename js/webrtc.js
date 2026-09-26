/* =========================================================
   js/webrtc.js
   ---------------------------------------------------------
   Host → guest screen sharing over WebRTC.

   Supabase Realtime is used ONLY as the signalling channel
   (offer / answer / ICE candidates). The video itself travels
   peer-to-peer and is never uploaded, recorded, or stored.

   One RTCPeerConnection is created per guest. For 2–3 people
   that is entirely sufficient; a mesh or SFU would be overkill.
   ========================================================= */

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
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
 * @param {string} options.selfId        our anonymous client id
 * @param {(msg:object)=>void} options.sendSignal
 * @param {(stream:MediaStream, fromId:string)=>void} options.onStream
 * @param {(state:'live'|'stopped'|'lost', peerId?:string)=>void} options.onStatus
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
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        onStatus?.('lost', peerId);
        closePeer(peerId);
      }
    };

    // Guest side: this is where the screen actually arrives.
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) onStream?.(stream, peerId);
    };

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
        'This browser cannot share the screen. Try Chrome or Safari on a phone, or Chrome on desktop.'
      );
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 24 },
          width: { max: 1280 },
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

    localStream = stream;
    sharing = true;

    // If the user stops sharing from the browser's own bar.
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        stop();
        onStatus?.('stopped');
      });
    }

    onStatus?.('live');
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
    } catch {
      closePeer(peerId);
    }
  }

  /* --------------------------------------------------- incoming signals */

  async function handleSignal(message) {
    if (!message || message.to !== selfId) return;

    const { from, kind, data } = message;

    if (kind === 'offer') {
      // Only the host may offer. Anybody else is ignored.
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
      } catch {
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

    get isSharing() {
      return sharing;
    },

    get stream() {
      return localStream;
    },

    destroy() {
      stop({ notify: false });
    },
  };
}