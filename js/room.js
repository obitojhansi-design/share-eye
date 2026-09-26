/* =========================================================
   js/room.js  —  room orchestrator
   ---------------------------------------------------------
   Wires together: database, realtime channel, presence,
   chat, player, screen sharing, reactions, fullscreen.

   The reaction system rides the existing Realtime channel
   (one extra broadcast event). The fullscreen UI replaces
   the previous inline fullscreen handler; nothing else in
   the room lifecycle has changed.
   ========================================================= */

console.log('[BUILD] Watch Together BUILD 2026-09-26-H');

import {
  sb,
  getClientId,
  getName,
  findRoom,
  joinRoom,
  leaveRoom,
  closeRoom,
  reopenRoom,
  persistState,
  loadRecentMessages,
  sendMessage,
  touchParticipant,
  normalizeCode,
} from './supabase.js';
import { CONFIG } from './config.js';
import { Player } from './player.js';
import { createChat } from './chat.js';
import { createScreenShare, isScreenShareSupported } from './webrtc.js';
import { createReactions } from './reactions.js';
import { createFullscreenUI } from './fullscreen-ui.js';

console.log('[BUILD] imports resolved');

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------- timeouts */

function withTimeout(promise, ms, label) {
  const p = Promise.resolve(promise);
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out. Check your connection and retry.`));
      }, ms);
    }),
  ]);
}

function withSoftTimeout(promise, ms, fallback) {
  const p = Promise.resolve(promise);
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/* ------------------------------------------------ retrying network calls */

async function retryNetwork(fn, label, {
  attempts = 3,
  perAttemptMs = 12000,
  onAttempt = null,
} = {}) {
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    if (onAttempt) onAttempt(i, attempts);
    console.log(`[ROOM] ${label} attempt ${i}/${attempts}`);

    try {
      const result = await withTimeout(fn(), perAttemptMs, label);
      console.log(`[ROOM] ${label} attempt ${i} succeeded`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[ROOM] ${label} attempt ${i} failed:`, err?.message);
      if (i < attempts) {
        const delay = 1000 * i;
        console.log(`[ROOM] Retrying ${label} in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr || new Error(`${label} failed after ${attempts} attempts.`);
}

/* ------------------------------------------------ room-open predicate */

function isRoomOpen(room) {
  if (!room) return false;
  if (room.closed_at) return false;
  if (!room.expires_at) return true;
  const expiresMs = new Date(room.expires_at).getTime();
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs > Date.now();
}

function isRoomExpired(room) {
  if (!room || !room.expires_at) return false;
  const ms = new Date(room.expires_at).getTime();
  return Number.isFinite(ms) && ms <= Date.now();
}

/* ------------------------------------------------------------- elements */

const els = {
  boot: $('#bootScreen'),
  bootText: $('#bootText'),
  bootRetry: $('#bootRetry'),
  bootBack: $('#bootBack'),

  app: $('#roomApp'),

  codeValue: $('#codeValue'),
  codeChip: $('#codeChip'),
  shareBtn: $('#shareBtn'),
  onlineCount: $('#onlineCount'),

  stage: $('#stage'),
  stageEmpty: $('#stageEmpty'),
  stageEmptySub: $('#stageEmptySub'),
  stageBadge: $('#stageBadge'),
  stageNote: $('#stageNote'),
  stageBlocker: $('#stageBlocker'),

  ytWrap: $('#ytWrap'),
  ytHost: $('#ytPlayer'),
  bbFrame: $('#bbFrame'),
  webFrame: $('#webFrame'),
  videoWrap: $('#videoWrap'),
  remoteVideo: $('#remoteVideo'),
  tapPlay: $('#tapPlay'),

  sourceTabs: $('#sourceTabs'),
  sourceBar: $('#sourceBar'),
  sourceInput: $('#sourceInput'),
  sourceGo: $('#sourceGo'),
  sourceCancel: $('#sourceCancel'),

  ytSearch: $('#ytSearch'),
  ytSearchForm: $('#ytSearchForm'),
  ytSearchInput: $('#ytSearchInput'),
  ytSearchGo: $('#ytSearchGo'),
  ytSearchNote: $('#ytSearchNote'),
  ytResults: $('#ytResults'),

  playBtn: $('#playBtn'),
  seek: $('#seek'),
  timeNow: $('#timeNow'),
  timeEnd: $('#timeEnd'),
  muteBtn: $('#muteBtn'),
  fsBtn: $('#fsBtn'),
  fsExit: $('#fsExit'),

  reactionBar: $('#reactionBar'),
  reactionLayer: $('#reactionLayer'),

  chatList: $('#chatList'),
  chatHint: $('#chatHint'),
  composer: $('#composer'),
  chatInput: $('#chatInput'),

  leaveBtn: $('#leaveBtn'),

  toast: $('#toast'),
};

/* ------------------------------------------------------------- utilities */

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer = 0;
function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

/* --------------------------------------------------- boot screen states */

function boot(text) {
  els.boot.classList.remove('is-error', 'is-prompt');
  els.bootText.textContent = text;
  els.boot.hidden = false;
  els.app.hidden = true;

  els.bootRetry.hidden = true;
  els.bootRetry.disabled = false;
  els.bootRetry.textContent = 'Retry';

  els.bootBack.hidden = true;
  els.bootBack.textContent = 'Back to start';
}

function bootFail(message, { retry = false } = {}) {
  els.boot.classList.remove('is-prompt');
  els.boot.classList.add('is-error');

  els.boot.hidden = false;
  els.app.hidden = true;

  els.bootText.textContent = message;

  els.bootBack.hidden = false;
  els.bootBack.textContent = 'Back to start';
  els.bootBack.onclick = () => { location.href = 'index.html'; };

  if (retry) {
    els.bootRetry.hidden = false;
    els.bootRetry.disabled = false;
    els.bootRetry.textContent = 'Retry';
    els.bootRetry.onclick = () => location.reload();
  } else {
    els.bootRetry.hidden = true;
  }
}

function bootOfferReopen(roomRow) {
  els.boot.classList.remove('is-error');
  els.boot.classList.add('is-prompt');

  els.boot.hidden = false;
  els.app.hidden = true;

  els.bootText.textContent = 'This room was closed. Reopen it?';

  els.bootBack.hidden = false;
  els.bootBack.textContent = 'Back to start';
  els.bootBack.onclick = () => { location.href = 'index.html'; };

  els.bootRetry.hidden = false;
  els.bootRetry.disabled = false;
  els.bootRetry.textContent = 'Reopen Room';
  els.bootRetry.onclick = async () => {
    els.bootRetry.disabled = true;
    els.bootRetry.textContent = 'Reopening…';
    try {
      await reopenRoom(roomRow.id);
      location.reload();
    } catch (err) {
      console.error('[ROOM] Reopen failed:', err);
      els.bootRetry.disabled = false;
      els.bootRetry.textContent = 'Try again';
      els.bootText.textContent =
        (err && err.message) || 'Could not reopen the room.';
    }
  };
}

function bootDone() {
  els.boot.classList.remove('is-error', 'is-prompt');
  els.boot.hidden = true;
  els.app.hidden = false;
}

/* ---------------------------------------------------------------- state */

const clientId = getClientId();
const myName = (getName() || '').trim().slice(0, 18);

let room = null;
let isHost = false;
let channel = null;
let player = null;
let chat = null;
let screenShare = null;
let reactions = null;
let fullscreenUI = null;

let peerIds = new Set();
let lastStatePush = 0;
let persistTimer = 0;
let heartbeatTimer = 0;
let hostGraceTimer = 0;
let participantTimer = 0;
let draggingSeek = false;
let leaving = false;
let searchInFlight = false;

const onlineIds = new Set();

/* ------------------------------------------------------------ bootstrap */

boot('Connecting…');

if (!myName) {
  bootFail('Please enter your name on the home page first.');
} else {
  start().catch((err) => {
    console.error('[BOOT FATAL]', err);
    console.error('[BOOT FATAL STACK]', err && err.stack);
    bootFail(
      (err && err.message) || 'Could not open this room.',
      { retry: true }
    );
  });
}

async function start() {
  console.log('[BOOT 01] start() entered');

  const params = new URLSearchParams(location.search);
  let code = normalizeCode(params.get('c'));

  if (code.length !== 6) {
    try {
      const pending = sessionStorage.getItem('wt.pendingRoom');
      if (pending) {
        const recovered = normalizeCode(pending);
        if (recovered.length === 6) {
          code = recovered;
          sessionStorage.removeItem('wt.pendingRoom');
          const url = new URL(location.href);
          url.searchParams.set('c', code);
          history.replaceState(null, '', url.toString());
        }
      }
    } catch { /* sessionStorage unavailable */ }
  }

  if (code.length !== 6) {
    bootFail('That room code is not valid.');
    return;
  }

  console.log('[ROOM] Parsed code:', code);
  els.codeValue.textContent = code;

  /* ---------------------------------------------------- findRoom */

  console.log('[BOOT 02] Before findRoom');
  const found = await retryNetwork(() => findRoom(code), 'findRoom', {
    attempts: 3,
    perAttemptMs: 12000,
    onAttempt: (i, total) => {
      boot(
        i === 1
          ? 'Looking for your room…'
          : `Still looking… (attempt ${i} of ${total})`
      );
    },
  });
  console.log('[BOOT 03] After findRoom', found ? found.code : null);

  if (!found) {
    bootFail('Room not found.');
    return;
  }

  room = found;
  isHost = room.host_id === clientId;

  /* ------------------------------------------- room lifecycle check */

  if (!isRoomOpen(room)) {
    const expired = isRoomExpired(room);

    console.log('[ROOM] Room is not open', {
      closed_at: room.closed_at,
      expires_at: room.expires_at,
      expired,
      isHost,
    });

    if (isHost && !expired) {
      console.log('[ROOM] Host can reopen this room');
      bootOfferReopen(room);
      return;
    }

    bootFail('That room has already ended.');
    return;
  }

  console.log('[ROOM] Room found:', room.code);
  console.log('[ROOM] isHost =', isHost);

  /* ------------------------------------------ participant count */

  console.log('[BOOT 04A] Before participant count query');
  const countResponse = await retryNetwork(
    () =>
      sb
        .from('participants')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', room.id)
        .gte(
          'last_seen',
          new Date(Date.now() - CONFIG.PARTICIPANT_TIMEOUT_MS).toISOString()
        ),
    'participant count',
    {
      attempts: 3,
      perAttemptMs: 10000,
      onAttempt: (i, total) => {
        if (i > 1) boot(`Checking the room… (attempt ${i} of ${total})`);
      },
    }
  );
  const count = countResponse?.count;
  console.log('[BOOT 04B] After participant count query, count =', count);

  if (!isHost && typeof count === 'number' && count >= CONFIG.MAX_PARTICIPANTS) {
    bootFail('This room is full.');
    return;
  }

  /* -------------------------------------------------- joinRoom */

  console.log('[BOOT 05A] Before joinRoom as', isHost ? 'host' : 'guest');
  await retryNetwork(() => joinRoom(room, myName), 'joinRoom', {
    attempts: 3,
    perAttemptMs: 10000,
    onAttempt: (i, total) => {
      if (i > 1) boot(`Joining the room… (attempt ${i} of ${total})`);
    },
  });
  console.log('[BOOT 05B] After joinRoom');

  /* ------------------------------------------------- setup sync */

  console.log('[BOOT 08A] Before setupPlayer');
  setupPlayer();
  console.log('[BOOT 08B] After setupPlayer');

  console.log('[BOOT 10A] Before setupChat');
  await setupChat();
  console.log('[BOOT 10B] After setupChat');

  console.log('[BOOT 12A] Before setupScreenShare');
  setupScreenShare();
  console.log('[BOOT 12B] After setupScreenShare');

  console.log('[BOOT 14A] Before setupControls');
  setupControls();
  console.log('[BOOT 14B] After setupControls');

  console.log('[BOOT 14.5A] Before setupReactions');
  setupReactions();
  console.log('[BOOT 14.5B] After setupReactions');

  console.log('[BOOT 14.6A] Before setupFullscreenUI');
  setupFullscreenUI();
  console.log('[BOOT 14.6B] After setupFullscreenUI');

  console.log('[BOOT 16A] Before setupChrome');
  setupChrome();
  console.log('[BOOT 16B] After setupChrome');

  console.log('[BOOT 17A] Before setupYouTubeSearch');
  setupYouTubeSearch();
  console.log('[BOOT 17B] After setupYouTubeSearch');

  /* ------------------------------------------------- realtime */

  console.log('[BOOT 18A] Before openChannelWithRetry');
  boot('Connecting to the room…');
  await openChannelWithRetry();
  console.log('[BOOT 18B] After openChannelWithRetry');

  /* --------------------------------------------------- done */

  console.log('[BOOT 20A] Before bootDone');
  bootDone();
  console.log('[BOOT 20B] After bootDone');

  setHostUi();

  if (room.state && room.state.kind && room.state.kind !== 'none') {
    player.applyState(room.state).catch(() => {});
  }

  startParticipantHeartbeat();
}

/* ---------------------------------------------------------- player setup */

function setupPlayer() {
  player = new Player(
    {
      empty: els.stageEmpty,
      emptySub: els.stageEmptySub,
      ytWrap: els.ytWrap,
      ytHost: els.ytHost,
      bbFrame: els.bbFrame,
      webFrame: els.webFrame,
      videoWrap: els.videoWrap,
      badge: els.stageBadge,
      note: els.stageNote,
    },
    {
      onState: (state) => pushState(state, { force: true }),

      onTick: ({ current, duration, playing }) => {
        if (!draggingSeek && duration > 0) {
          els.seek.value = String(Math.round((current / duration) * 1000));
        }
        els.timeNow.textContent = formatTime(current);
        els.timeEnd.textContent = formatTime(duration);

        if (isHost) {
          els.playBtn.textContent = playing ? '❚❚' : '▶';
          els.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        } else if (player.lastRemoteState) {
          els.playBtn.textContent = player.lastRemoteState.playing ? '❚❚' : '▶';
        }
      },

      onNotice: (text) => {
        player.setNote(text);
        toast(text, 3400);
      },

      onError: (text) => toast(text, 3200),
    }
  );

  els.seek.disabled = !isHost;
  els.playBtn.disabled = !isHost;
  els.muteBtn.disabled = !isHost;
}

/* ------------------------------------------------------------ chat setup */

async function setupChat() {
  chat = createChat({
    listEl: els.chatList,
    formEl: els.composer,
    inputEl: els.chatInput,
    hintEl: els.chatHint,
    onSend: async (text) => {
      try {
        await sendMessage(room.id, clientId, myName, text);
      } catch (err) {
        toast(err.message || 'Message could not be sent.');
        throw err;
      }
    },
  });

  chat.setSelfId(clientId);

  const recent = await withSoftTimeout(
    loadRecentMessages(room.id).catch((err) => {
      console.warn('[CHAT] History fetch failed:', err);
      return [];
    }),
    4000,
    []
  );

  if (recent && recent.length) chat.addHistory(recent);
}

/* -------------------------------------------------- screen share setup */

function setupScreenShare() {
  if (!isScreenShareSupported()) {
    els.sourceTabs
      .querySelector('[data-src="screen"]')
      ?.setAttribute('title', 'Screen sharing is not available in this browser.');
  }

  screenShare = createScreenShare({
    selfId: clientId,
    sendSignal: (message) => {
      channel?.send({
        type: 'broadcast',
        event: 'sig',
        payload: { ...message, from: clientId },
      });
    },
    onStream: (stream, fromId) => {
      if (stream) {
        els.remoteVideo.srcObject = stream;
        els.videoWrap.hidden = false;
        els.tapPlay.hidden = false;
        player.setKind('screen');
        player.setBadge('LIVE SCREEN');
        attemptPlayback();
      } else {
        els.remoteVideo.srcObject = null;
        els.tapPlay.hidden = true;
        if (fromId) player.setBadge(null);
      }
    },
    onStatus: (state, info) => {
      if (state === 'live') {
        player.setBadge('SHARING');
        if (info && info.hasAudio === false) {
          toast(
            'Screen is shared without audio. This browser does not capture system audio — try Chrome on desktop.',
            5200
          );
        } else {
          toast('Screen sharing started.');
        }
      }
      if (state === 'stopped') {
        player.setBadge(null);
        player.setKind('none');
        player.setEmptySubtitle('Screen sharing has stopped.');
        pushState({ kind: 'none', src: null, playing: false, position: 0 });
      }
      if (state === 'lost') {
        toast('A viewer lost the screen connection.');
      }
    },
  });

  els.tapPlay.addEventListener('click', () => {
    els.tapPlay.hidden = true;
    attemptPlayback();
  });
}

function attemptPlayback() {
  const video = els.remoteVideo;
  const promise = video.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      els.tapPlay.hidden = false;
    });
  }
}

/* ------------------------------------------------------- controls setup */

function setupControls() {
  els.playBtn.addEventListener('click', () => {
    if (!isHost) return;
    const state = player.snapshot();
    if (state.playing) player.pause();
    else player.play();
  });

  els.muteBtn.addEventListener('click', () => {
    if (!isHost) return;
    const next = !player.isMuted();
    player.setMuted(next);
    els.muteBtn.textContent = next ? '🔇' : '🔊';
  });

  els.seek.addEventListener('input', () => {
    draggingSeek = true;
    if (player.kind === 'youtube' && player.yt && player.ytReady) {
      const duration = Number(player.yt.getDuration?.() || 0);
      if (duration > 0) {
        els.timeNow.textContent = formatTime(
          (Number(els.seek.value) / 1000) * duration
        );
      }
    }
  });

  els.seek.addEventListener('change', () => {
    draggingSeek = false;
    if (!isHost) return;
    if (player.kind !== 'youtube' || !player.yt || !player.ytReady) return;
    const duration = Number(player.yt.getDuration?.() || 0);
    if (duration <= 0) return;
    const target = (Number(els.seek.value) / 1000) * duration;
    player.seekTo(target);
  });

  // NOTE: #fsBtn is wired by setupFullscreenUI(). It is intentionally
  // not attached here to avoid two handlers firing per tap.

  els.sourceTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    handleSourceTab(tab.dataset.src);
  });

  els.sourceBar.addEventListener('submit', (event) => {
    event.preventDefault();
    loadFromInput();
  });

  els.sourceCancel.addEventListener('click', () => {
    els.sourceBar.hidden = true;
    els.sourceInput.value = '';
  });

  els.leaveBtn.addEventListener('click', () => {
    if (isHost) {
      const ok = window.confirm(
        'You are the host. Leaving will end the room for everyone.\n\nEnd the session?'
      );
      if (ok) leave({ endRoom: true });
    } else {
      leave({ endRoom: false });
    }
  });
}

/* ------------------------------------------------------ reactions setup */

function setupReactions() {
  reactions = createReactions({
    barEl: els.reactionBar,
    layerEl: els.reactionLayer,
    onSend: (emoji) => {
      if (!emoji) return;

      const payload = {
        id:
          (crypto.randomUUID && crypto.randomUUID()) ||
          String(Date.now()),
        emoji,
        name: myName,
        at: Date.now(),
      };

      console.log('[REACTION] sending', payload);

      // Show locally right away so the sender sees feedback even
      // though the channel is configured with `broadcast.self: false`
      // and will not echo the event back to this client.
      reactions.show(payload);

      channel?.send({
        type: 'broadcast',
        event: 'reaction',
        payload,
      });
    },
  });
}

/* ----------------------------------------------------- fullscreen setup */

function setupFullscreenUI() {
  fullscreenUI = createFullscreenUI({
    appEl: els.app,
    toggleBtn: els.fsBtn,
    exitBtn: els.fsExit,
    onEnter: () => console.log('[FULLSCREEN] entered'),
    onExit: () => console.log('[FULLSCREEN] exited'),
    onError: (msg) => toast(msg || 'Fullscreen is not available.'),
  });
}

/* ---------------------------------------------------------- chrome setup */

function setupChrome() {
  els.codeChip.addEventListener('click', async () => {
    const code = room.code;
    try {
      await navigator.clipboard.writeText(code);
      toast('Room code copied.');
    } catch {
      toast(`Room code: ${code}`, 4000);
    }
  });

  els.shareBtn.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?c=${room.code}`;
    const data = {
      title: 'Watch Together',
      text: `Join my room with code ${room.code}`,
      url,
    };

    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch { /* user cancelled or share failed */ }
    }

    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(`Room code: ${room.code}`, 4000);
    }
  });
}

/* ------------------------------------------------ YouTube search setup */

function setupYouTubeSearch() {
  if (!CONFIG.YOUTUBE_API_KEY) {
    els.ytSearchNote.hidden = false;
  }

  els.ytSearchForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (searchInFlight) return;
    if (!isHost) {
      toast('Only the host can change what is playing.');
      return;
    }

    const query = els.ytSearchInput.value.trim();
    if (!query) return;

    await runYouTubeSearch(query);
  });

  els.ytResults.addEventListener('click', (event) => {
    const item = event.target.closest('.yt-result');
    if (!item) return;
    const videoId = item.dataset.id;
    if (!videoId) return;
    loadVideoById(videoId);
  });
}

async function runYouTubeSearch(query) {
  searchInFlight = true;
  els.ytSearchGo.disabled = true;
  els.ytSearchGo.textContent = '…';
  els.ytResults.replaceChildren();

  try {
    const key = CONFIG.YOUTUBE_API_KEY;

    if (!key) {
      const url =
        `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
      window.open(url, '_blank', 'noopener');
      els.ytSearchNote.hidden = false;
      toast('Copy a video URL from YouTube back into the paste field.', 5000);
      return;
    }

    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('q', query);
    url.searchParams.set('key', key);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`YouTube search failed (${res.status}).`);
    }
    const data = await res.json();
    const items = (data.items || [])
      .filter((it) => it.id && it.id.videoId)
      .map((it) => ({
        id: it.id.videoId,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
        thumb:
          it.snippet.thumbnails?.default?.url ||
          `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`,
      }));

    renderSearchResults(items);
  } catch (err) {
    console.warn('[YT] Search failed:', err);
    const empty = document.createElement('p');
    empty.className = 'yt-empty';
    empty.textContent =
      err.message || 'Search failed. Check your connection and try again.';
    els.ytResults.appendChild(empty);
  } finally {
    searchInFlight = false;
    els.ytSearchGo.disabled = false;
    els.ytSearchGo.textContent = 'Search';
  }
}

function renderSearchResults(items) {
  els.ytResults.replaceChildren();

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'yt-empty';
    empty.textContent = 'No results.';
    els.ytResults.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'yt-result';
    row.dataset.id = item.id;
    row.setAttribute('role', 'option');

    const img = document.createElement('img');
    img.className = 'yt-result-thumb';
    img.src = item.thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';

    const wrap = document.createElement('div');
    wrap.className = 'yt-result-text';

    const title = document.createElement('span');
    title.className = 'yt-result-title';
    title.textContent = item.title;

    const channel = document.createElement('span');
    channel.className = 'yt-result-channel';
    channel.textContent = item.channel;

    wrap.append(title, channel);
    row.append(img, wrap);
    els.ytResults.appendChild(row);
  }
}

async function loadVideoById(videoId) {
  if (!isHost) return;

  try {
    const result = await player.show('youtube', videoId);

    els.ytSearch.hidden = true;
    els.sourceBar.hidden = true;
    els.sourceInput.value = '';
    els.ytSearchInput.value = '';
    els.ytResults.replaceChildren();

    pushState(
      {
        kind: result.kind,
        src: result.src,
        playing: false,
        position: 0,
        at: Date.now(),
      },
      { force: true, persist: true }
    );
  } catch (err) {
    toast(err.message || 'That video could not be loaded.');
  }
}

/* ------------------------------------------------------- source handling */

function handleSourceTab(kind) {
  if (!isHost) {
    toast('Only the host can change what is playing.');
    return;
  }

  for (const tab of els.sourceTabs.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.src === kind);
  }

  els.ytSearch.hidden = true;
  els.sourceBar.hidden = true;

  if (kind === 'screen') {
    toggleScreenShare();
    return;
  }

  if (kind === 'youtube') {
    els.sourceInput.placeholder = 'YouTube link or video ID';
    els.sourceInput.type = 'text';
    els.ytSearch.hidden = false;
    els.sourceBar.hidden = false;
    els.ytSearchInput.focus();
    return;
  }

  if (kind === 'bilibili') {
    els.sourceInput.placeholder = 'Bilibili link (BV…)';
    els.sourceInput.type = 'text';
  } else if (kind === 'website') {
    els.sourceInput.placeholder = 'https://example.com';
    els.sourceInput.type = 'url';
  }

  els.sourceBar.hidden = false;
  els.sourceInput.focus();
}

async function loadFromInput() {
  if (!isHost) return;

  const raw = els.sourceInput.value.trim();
  if (!raw) return;

  const active = els.sourceTabs.querySelector('.tab.active');
  const kind = active?.dataset.src || 'youtube';

  try {
    let result;
    if (kind === 'youtube') {
      result = await player.show('youtube', raw);
    } else if (kind === 'bilibili') {
      result = await player.show('bilibili', raw);
    } else if (kind === 'website') {
      result = await player.show('website', raw);
    } else {
      return;
    }

    els.sourceBar.hidden = true;
    els.sourceInput.value = '';
    els.ytSearch.hidden = true;

    pushState(
      {
        kind: result.kind,
        src: result.src,
        playing: false,
        position: 0,
        at: Date.now(),
      },
      { force: true, persist: true }
    );
  } catch (err) {
    toast(err.message || 'That link could not be loaded.');
  }
}

async function toggleScreenShare() {
  if (!isHost) return;

  if (screenShare.isSharing) {
    screenShare.stop();
    return;
  }

  try {
    await screenShare.start();

    for (const peerId of peerIds) {
      await screenShare.connectTo(peerId);
    }

    player.setKind('screen');
    player.setBadge('SHARING');
    player.setEmptySubtitle('Your screen is being shared.');

    pushState(
      { kind: 'screen', src: null, playing: false, position: 0 },
      { force: true, persist: true }
    );
  } catch (err) {
    toast(err.message || 'Screen sharing could not start.');
    for (const tab of els.sourceTabs.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab.dataset.src === player.kind);
    }
  }
}

/* ----------------------------------------------------------- host UI */

function setHostUi() {
  const blockable =
    player.kind === 'youtube' ||
    player.kind === 'bilibili' ||
    player.kind === 'website';

  els.stageBlocker.hidden = isHost || !blockable;

  els.seek.disabled = !isHost;
  els.playBtn.disabled = !isHost;
  els.muteBtn.disabled = !isHost;

  const screenTab = els.sourceTabs.querySelector('[data-src="screen"]');
  if (screenTab) {
    screenTab.textContent = isHost
      ? screenShare?.isSharing
        ? 'Stop Share'
        : 'Share'
      : 'Share';
  }

  if (!isHost) {
    const active = els.sourceTabs.querySelector('.tab.active');
    if (active) active.classList.remove('active');
    els.ytSearch.hidden = true;
  }

  els.chatHint.textContent = isHost ? 'You are the host' : '';
}

/* --------------------------------------------------------- realtime */

async function openChannelWithRetry(attempt = 1) {
  try {
    await openChannel();
  } catch (err) {
    console.warn(`[REALTIME] Attempt ${attempt} failed:`, err?.message);
    if (attempt < 3) {
      const delay = 1200 * attempt;
      console.log(`[REALTIME] Retrying in ${delay}ms…`);
      boot(`Connecting to the room… (attempt ${attempt + 1} of 3)`);
      await new Promise((r) => setTimeout(r, delay));
      return openChannelWithRetry(attempt + 1);
    }
    throw new Error(
      'Could not connect to the room. Please check your connection and retry.'
    );
  }
}

function openChannel() {
  return new Promise((resolve, reject) => {
    const name = `room:${room.code}`;
    console.log('[REALTIME] Creating channel:', name);

    if (channel) {
      try { sb.removeChannel(channel); } catch { /* ignore */ }
      channel = null;
    }

    let settled = false;
    let localTimer = 0;

    const settle = (kind, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(localTimer);
      if (kind === 'resolve') resolve(value);
      else reject(value);
    };

    try {
      channel = sb.channel(name, {
        config: {
          broadcast: { self: false },
          presence: { key: clientId },
        },
      });
      console.log('[REALTIME] Channel object created');
    } catch (err) {
      console.error('[REALTIME] sb.channel() threw:', err);
      settle('reject', new Error('Could not create the realtime channel.'));
      return;
    }

    const attach = (label, fn) => {
      try {
        fn();
        console.log('[REALTIME] Listener attached:', label);
      } catch (err) {
        console.error('[REALTIME] Listener failed to attach:', label, err);
      }
    };

    attach('presence:sync', () => {
      channel.on('presence', { event: 'sync' }, () => handlePresence());
    });

    attach('broadcast:state', () => {
      channel.on('broadcast', { event: 'state' }, ({ payload }) => {
        if (isHost) return;
        player.applyState(payload).catch(() => {});
      });
    });

    attach('broadcast:sig', () => {
      channel.on('broadcast', { event: 'sig' }, ({ payload }) => {
        screenShare?.handleSignal(payload);
      });
    });

    attach('broadcast:notice', () => {
      channel.on('broadcast', { event: 'notice' }, ({ payload }) => {
        if (!payload?.text) return;
        chat.system(payload.text);
      });
    });

    attach('broadcast:reaction', () => {
      channel.on('broadcast', { event: 'reaction' }, ({ payload }) => {
        console.log('[REACTION] received', payload);
        reactions?.show(payload);
      });
    });

    attach('postgres_changes:messages', () => {
      channel.on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${room.id}`,
        },
        ({ new: row }) => chat.add(row)
      );
    });

    localTimer = setTimeout(() => {
      console.error('[REALTIME] LOCAL TIMEOUT — no status received within 12s');
      try { channel?.unsubscribe(); } catch { /* ignore */ }
      settle('reject', new Error('The realtime connection timed out.'));
    }, 12000);

    console.log('[REALTIME] Calling subscribe()');
    channel.subscribe((status, err) => {
      console.log('[REALTIME] STATUS:', status, err || '');

      if (status === 'SUBSCRIBED') {
        clearTimeout(localTimer);

        channel
          .track({
            name: myName,
            is_host: isHost,
            joined_at: new Date().toISOString(),
          })
          .then(() => console.log('[REALTIME] Presence tracked'))
          .catch((e) => console.warn('[REALTIME] track failed:', e));

        try { announce(`${myName} joined the room.`); } catch (e) {
          console.warn('[REALTIME] announce failed:', e);
        }
        try { startStateHeartbeat(); } catch (e) {
          console.warn('[REALTIME] heartbeat failed:', e);
        }

        settle('resolve');
      } else if (status === 'CHANNEL_ERROR') {
        settle('reject', new Error('The realtime channel failed to connect.'));
      } else if (status === 'TIMED_OUT') {
        settle('reject', new Error('The realtime connection timed out.'));
      } else if (status === 'CLOSED') {
        settle('reject', new Error('The realtime channel closed unexpectedly.'));
      }
    });
  });
}

/* ---------------------------------------------------------- presence */

function handlePresence() {
  const presenceState = channel.presenceState();

  onlineIds.clear();
  let hostPresent = false;

  for (const [key, values] of Object.entries(presenceState)) {
    if (!values || !values.length) continue;
    onlineIds.add(key);
    for (const value of values) {
      if (value.is_host) hostPresent = true;
    }
  }

  els.onlineCount.textContent = String(onlineIds.size || 1);

  if (!isHost) {
    if (!hostPresent && onlineIds.size > 0) {
      if (!hostGraceTimer) {
        toast('The host disconnected. Waiting for them to return…', 5000);
        hostGraceTimer = setTimeout(() => {
          endSession('The host left the room.');
        }, CONFIG.HOST_GRACE_MS);
      }
    } else if (hostPresent && hostGraceTimer) {
      clearTimeout(hostGraceTimer);
      hostGraceTimer = 0;
      toast('The host is back.');
    }
  }

  if (isHost && screenShare?.isSharing) {
    for (const id of onlineIds) {
      if (id !== clientId) screenShare.connectTo(id);
    }
  }

  peerIds = new Set([...onlineIds].filter((id) => id !== clientId));
}

/* ------------------------------------------------------ state broadcast */

function pushState(state, { force = false, persist = false } = {}) {
  if (!isHost || !channel) return;

  const now = Date.now();
  if (!force && now - lastStatePush < 400) return;
  lastStatePush = now;

  channel.send({
    type: 'broadcast',
    event: 'state',
    payload: state,
  });

  if (persist) {
    persistTimer = Date.now();
    persistState(room.id, state).catch(() => {});
  }
}

function startStateHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!isHost) {
      player.resync();
      return;
    }

    const state = player.snapshot();

    if (state.kind === 'youtube' && state.playing) {
      pushState(state, { force: true });
    }

    if (Date.now() - persistTimer > CONFIG.STATE_PERSIST_MS) {
      persistTimer = Date.now();
      persistState(room.id, state).catch(() => {});
    }
  }, CONFIG.STATE_HEARTBEAT_MS);
}

function announce(text) {
  channel?.send({ type: 'broadcast', event: 'notice', payload: { text } });
  chat?.system(text);
}

/* ---------------------------------------------------- participant upkeep */

function startParticipantHeartbeat() {
  clearInterval(participantTimer);
  participantTimer = setInterval(() => {
    if (leaving) return;
    touchParticipant(room.id, clientId).catch(() => {});
    setHostUi();
  }, 25000);
}

/* ------------------------------------------------------------ teardown */

function endSession(reason) {
  if (leaving) return;
  leaving = true;

  clearInterval(heartbeatTimer);
  clearInterval(participantTimer);
  clearTimeout(hostGraceTimer);

  try { screenShare?.destroy(); } catch { /* ignore */ }
  try { player?.destroy(); } catch { /* ignore */ }
  try { reactions?.destroy(); } catch { /* ignore */ }
  try { fullscreenUI?.destroy(); } catch { /* ignore */ }

  toast(reason, 3000);

  setTimeout(() => {
    location.href = 'index.html';
  }, 1600);
}

async function leave({ endRoom = false } = {}) {
  if (leaving) return;
  leaving = true;

  clearInterval(heartbeatTimer);
  clearInterval(participantTimer);
  clearTimeout(hostGraceTimer);

  try { screenShare?.destroy(); } catch { /* ignore */ }
  try { player?.destroy(); } catch { /* ignore */ }
  try { reactions?.destroy(); } catch { /* ignore */ }
  try { fullscreenUI?.destroy(); } catch { /* ignore */ }

  if (channel) {
    if (endRoom) {
      channel.send({
        type: 'broadcast',
        event: 'notice',
        payload: { text: 'The host ended the session.' },
      });
    }
    try { await channel.untrack(); } catch { /* ignore */ }
    try { await sb.removeChannel(channel); } catch { /* ignore */ }
    channel = null;
  }

  await leaveRoom(room.id, clientId).catch(() => {});

  if (endRoom) {
    await closeRoom(room.id).catch(() => {});
  }

  location.href = 'index.html';
}

/* ---------------------------------------------------------- last rites */

// NOTE: We deliberately do NOT close the room on pagehide. Doing so
// used to close rooms the host was only navigating away from, which
// then made `isRoomOpen()` reject the room when the host returned.

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!channel || leaving) return;
  channel
    .track({
      name: myName,
      is_host: isHost,
      joined_at: new Date().toISOString(),
    })
    .catch(() => {});
  touchParticipant(room.id, clientId).catch(() => {});
});