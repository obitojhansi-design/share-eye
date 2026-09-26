/* =========================================================
   js/player.js
   ---------------------------------------------------------
   Owns the watch area for the three embeddable sources.

   YouTube  — full play / pause / seek synchronisation via the
              official IFrame Player API.
   Bilibili — the public player iframe. It exposes no control API,
              so only the *selection* (which video, which page) can
              be synchronised. This is a real browser limitation,
              not something to work around.
   Website  — a plain sandboxed iframe. Many sites send
              X-Frame-Options / CSP frame-ancestors and will refuse
              to render. We surface that honestly instead of
              proxying anything.
   ========================================================= */

const YT_API_SRC = 'https://www.youtube.com/iframe_api';
let ytApiPromise = null;

function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('YouTube took too long to load.'));
    }, 12000);

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };

    const script = document.createElement('script');
    script.src = YT_API_SRC;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('YouTube could not be loaded.'));
    };
    document.head.appendChild(script);
  });

  return ytApiPromise;
}

/* -------------------------------------------------------- link parsing */

export function parseYouTubeId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // A bare 11-character video id.
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./i, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

    const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }

  return null;
}

export function parseBilibili(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const bv = raw.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0], page: 1 };

  const av = raw.match(/av(\d+)/i);
  if (av) return { aid: av[1], page: 1 };

  return null;
}

export function isHttpUrl(input) {
  try {
    const u = new URL(String(input || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- Player */

export class Player {
  /**
   * @param {object} refs   DOM references
   * @param {object} hooks  { onState, onTick, onNotice, onError }
   */
  constructor(refs, hooks = {}) {
    this.refs = refs;
    this.hooks = hooks;

    this.kind = 'none';
    this.srcKey = null;

    this.yt = null;
    this.ytReady = false;
    this.pendingYouTubeState = null;

    this.applying = false;
    this.applyTimer = 0;
    this.lastRemoteState = null;

    this.tickTimer = 0;

    this._startTicker();
  }

  /* ------------------------------------------------------- visibility */

  _setVisible(kind) {
    const r = this.refs;
    if (r.empty) r.empty.hidden = kind !== 'none';
    if (r.ytWrap) r.ytWrap.hidden = kind !== 'youtube';
    if (r.bbFrame) r.bbFrame.hidden = kind !== 'bilibili';
    if (r.webFrame) r.webFrame.hidden = kind !== 'website';
    if (r.videoWrap) r.videoWrap.hidden = kind !== 'screen';
  }

  /** Bookkeeping + visibility only. Used for 'screen' and 'none'. */
  setKind(kind) {
    this.kind = kind;
    if (kind !== 'youtube' && this.yt) {
      try { this.yt.destroy(); } catch { /* ignore */ }
      this.yt = null;
      this.ytReady = false;
    }
    this._setVisible(kind);
  }

  setEmptySubtitle(text) {
    if (this.refs.emptySub) this.refs.emptySub.textContent = text;
  }

  setBadge(text) {
    const el = this.refs.badge;
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  setNote(text) {
    const el = this.refs.note;
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /* ------------------------------------------------------------ loading */

  /**
   * Load a source.
   * @param {'youtube'|'bilibili'|'website'} kind
   * @param {string} src  video id / bvid / url
   */
  async show(kind, src, { silent = false } = {}) {
    if (kind === 'youtube') return this._showYouTube(src, silent);
    if (kind === 'bilibili') return this._showBilibili(src, silent);
    if (kind === 'website') return this._showWebsite(src, silent);
    this.setKind('none');
    return null;
  }

  async _showYouTube(videoId, silent) {
    if (!videoId) throw new Error('That does not look like a YouTube link.');

    this.setNote(null);
    this.kind = 'youtube';
    this.srcKey = videoId;
    this._setVisible('youtube');

    const YT = await loadYouTubeApi();

    // Same video already loaded → nothing to rebuild.
    if (this.yt && this.ytReady && this._loadedVideoId === videoId) {
      return { kind: 'youtube', src: videoId };
    }

    this._loadedVideoId = videoId;

    if (this.yt) {
      try { this.yt.destroy(); } catch { /* ignore */ }
      this.yt = null;
      this.ytReady = false;
    }

    this.refs.ytHost.replaceChildren();

    await new Promise((resolve) => {
      this.yt = new YT.Player(this.refs.ytHost, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,        // our own control bar drives everything
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          fs: 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => {
            this.ytReady = true;
            if (this.pendingYouTubeState) {
              const pending = this.pendingYouTubeState;
              this.pendingYouTubeState = null;
              this.applyState(pending);
            }
            resolve();
          },
          onStateChange: (event) => {
            if (this.applying) return;
            // 1 = playing, 2 = paused, 0 = ended
            if (event.data === 1 || event.data === 2 || event.data === 0) {
              this._emitLocal();
            }
          },
          onError: () => {
            if (!silent) {
              this.hooks.onNotice?.('This YouTube video cannot be played here.');
            }
          },
        },
      });
    });

    return { kind: 'youtube', src: videoId };
  }

  _showBilibili(bvid, silent) {
    const parsed = parseBilibili(bvid) || (bvid && bvid.bvid ? bvid : null);
    if (!parsed) throw new Error('That does not look like a Bilibili link.');

    const key = parsed.bvid ? `${parsed.bvid}:${parsed.page}` : `av${parsed.aid}:${parsed.page}`;

    // Nothing to reload if it is already showing.
    if (this.kind === 'bilibili' && this.srcKey === key) {
      return { kind: 'bilibili', src: key };
    }

    const query = parsed.bvid
      ? `bvid=${encodeURIComponent(parsed.bvid)}`
      : `aid=${encodeURIComponent(parsed.aid)}`;

    this.refs.bbFrame.src =
      `https://player.bilibili.com/player.html?${query}` +
      `&page=${parsed.page}&autoplay=0&high_quality=1&danmaku=0`;

    this.kind = 'bilibili';
    this.srcKey = key;
    this._setVisible('bilibili');

    this.setNote(
      'Bilibili does not allow other sites to control its player, ' +
        'so only the choice of video is shared. Play and pause manually.'
    );

    return { kind: 'bilibili', src: key };
  }

  _showWebsite(url, silent) {
    if (!isHttpUrl(url)) throw new Error('That does not look like a web address.');

    if (this.kind === 'website' && this.srcKey === url) {
      return { kind: 'website', src: url };
    }

    this.refs.webFrame.src = url;
    this.kind = 'website';
    this.srcKey = url;
    this._setVisible('website');

    this.setNote(
      'If this stays blank, the site blocks being shown inside another page. ' +
        'Use Screen Share instead.'
    );

    return { kind: 'website', src: url };
  }

  /* --------------------------------------------------------- host sync */

  /** Build the state object the host broadcasts. */
  snapshot(extra = {}) {
    const base = {
      kind: this.kind,
      src: this.srcKey,
      at: Date.now(),
      ...extra,
    };

    if (this.kind === 'youtube' && this.yt && this.ytReady) {
      base.position = Number(this.yt.getCurrentTime?.() || 0);
      base.playing = this.yt.getPlayerState?.() === 1;
    } else if (this.kind === 'youtube') {
      base.position = 0;
      base.playing = false;
    }

    return base;
  }

  /** Only called for genuine user actions on the host's device. */
  _emitLocal() {
    if (!this.hooks.onState) return;
    this.hooks.onState(this.snapshot());
  }

  /* ---------------------------------------------------- remote apply */

  /** Apply a state broadcast by the host. */
  async applyState(state) {
    if (!state || !state.kind || state.kind === 'none') return;

    this.lastRemoteState = state;

    const key = state.src || null;
    const needsLoad = this.kind !== state.kind || this.srcKey !== key;

    if (needsLoad) {
      try {
        await this.show(state.kind, state.src, { silent: true });
      } catch (err) {
        this.hooks.onError?.(err.message);
        return;
      }
    }

    if (state.kind === 'youtube') this._applyYouTube(state);
  }

  _applyYouTube(state) {
    if (!this.yt || !this.ytReady) {
      this.pendingYouTubeState = state;
      return;
    }

    const player = this.yt;
    const elapsed = state.playing ? (Date.now() - (state.at || Date.now())) / 1000 : 0;
    const target = Math.max(0, Number(state.position || 0) + elapsed);

    this.applying = true;

    try {
      const current = Number(player.getCurrentTime?.() || 0);
      // Only correct meaningful drift — constant micro-seeking sounds awful.
      if (Math.abs(current - target) > 2) {
        player.seekTo(target, true);
      }

      const isPlaying = player.getPlayerState?.() === 1;
      if (state.playing && !isPlaying) player.playVideo();
      if (!state.playing && isPlaying) player.pauseVideo();
    } catch { /* the player may still be booting */ }

    clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applying = false;
    }, 700);
  }

  /** Re-run the last known state (drift correction). */
  resync() {
    if (this.lastRemoteState) this._applyYouTube(this.lastRemoteState);
  }

  /* ---------------------------------------------------- local controls */

  play() {
    if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return;
    this.applying = true;
    this.yt.playVideo();
    setTimeout(() => { this.applying = false; }, 500);
    this._emitLocal();
  }

  pause() {
    if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return;
    this.applying = true;
    this.yt.pauseVideo();
    setTimeout(() => { this.applying = false; }, 500);
    this._emitLocal();
  }

  seekTo(seconds) {
    if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return;
    this.applying = true;
    this.yt.seekTo(Math.max(0, seconds), true);
    setTimeout(() => { this.applying = false; }, 700);
    this._emitLocal();
  }

  setMuted(muted) {
    if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return;
    try {
      if (muted) this.yt.mute();
      else this.yt.unMute();
    } catch { /* ignore */ }
  }

  isMuted() {
    if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return false;
    try { return !!this.yt.isMuted?.(); } catch { return false; }
  }

  /* ----------------------------------------------------------- ticker */

  _startTicker() {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (this.kind !== 'youtube' || !this.yt || !this.ytReady) return;
      try {
        const current = Number(this.yt.getCurrentTime?.() || 0);
        const duration = Number(this.yt.getDuration?.() || 0);
        const playing = this.yt.getPlayerState?.() === 1;
        this.hooks.onTick?.({ current, duration, playing });
      } catch { /* ignore */ }
    }, 500);
  }

  /* ---------------------------------------------------------- teardown */

  destroy() {
    clearInterval(this.tickTimer);
    clearTimeout(this.applyTimer);
    if (this.yt) {
      try { this.yt.destroy(); } catch { /* ignore */ }
      this.yt = null;
    }
    this.ytReady = false;
  }
}