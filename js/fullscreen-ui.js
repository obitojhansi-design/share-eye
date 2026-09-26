/* =========================================================
   js/fullscreen-ui.js
   ---------------------------------------------------------
   Fullscreen control for the room.

   • Target is the whole #roomApp so the chat travels into
     fullscreen with the stage.
   • On enter, try to lock landscape orientation — this is
     only attempted on touch devices and is a best-effort
     call. Failure is logged and ignored; it never blocks
     fullscreen.
   • On exit (by button, by user, or by the browser UI), the
     orientation lock is released if we were the ones who
     acquired it.
   ========================================================= */

export function createFullscreenUI({
  appEl,
  toggleBtn,
  exitBtn,
  onEnter,
  onExit,
  onError,
}) {
  let active = false;
  let weLockedOrientation = false;

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      null
    );
  }

  function isSupported() {
    return !!(
      appEl &&
      (appEl.requestFullscreen || appEl.webkitRequestFullscreen)
    );
  }

  async function tryLockLandscape() {
    if (typeof screen === 'undefined') return;
    if (!screen.orientation || typeof screen.orientation.lock !== 'function') {
      return;
    }

    // Only worth attempting on touch devices. Desktop orientation
    // locks are usually refused and pointless.
    const isCoarsePointer = window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
    if (!isCoarsePointer) return;

    try {
      await screen.orientation.lock('landscape');
      weLockedOrientation = true;
      console.log('[ORIENTATION] Landscape lock acquired');
    } catch (err) {
      console.log('[ORIENTATION] Landscape lock unavailable:', err?.message);
    }
  }

  function tryUnlockOrientation() {
    if (!weLockedOrientation) return;
    try {
      if (
        typeof screen !== 'undefined' &&
        screen.orientation &&
        typeof screen.orientation.unlock === 'function'
      ) {
        screen.orientation.unlock();
        console.log('[ORIENTATION] Landscape lock released');
      }
    } catch (err) {
      console.log('[ORIENTATION] Unlock failed:', err?.message);
    }
    weLockedOrientation = false;
  }

  async function enter() {
    if (!isSupported()) {
      onError?.('Fullscreen is not supported on this browser.');
      return;
    }

    try {
      if (appEl.requestFullscreen) {
        await appEl.requestFullscreen({ navigationUI: 'hide' });
      } else if (appEl.webkitRequestFullscreen) {
        appEl.webkitRequestFullscreen();
      }
    } catch (err) {
      console.warn('[FULLSCREEN] enter failed:', err);
      onError?.('Could not enter fullscreen.');
      return;
    }

    await tryLockLandscape();
  }

  async function exit() {
    if (!getFullscreenElement()) return;
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (err) {
      console.warn('[FULLSCREEN] exit failed:', err);
    }
  }

  async function toggle() {
    if (getFullscreenElement()) {
      await exit();
    } else {
      await enter();
    }
  }

  function handleChange() {
    const fsEl = getFullscreenElement();
    const nowActive = fsEl === appEl;
    if (nowActive === active) return;
    active = nowActive;

    document.body.classList.toggle('is-fullscreen', active);

    if (active) {
      onEnter?.();
    } else {
      tryUnlockOrientation();
      onExit?.();
    }
  }

  document.addEventListener('fullscreenchange', handleChange);
  document.addEventListener('webkitfullscreenchange', handleChange);

  const onToggleClick = () => { toggle().catch(() => {}); };
  const onExitClick = () => { exit().catch(() => {}); };

  if (toggleBtn) toggleBtn.addEventListener('click', onToggleClick);
  if (exitBtn) exitBtn.addEventListener('click', onExitClick);

  return {
    toggle,
    enter,
    exit,
    isActive: () => active,
    isSupported,
    destroy() {
      document.removeEventListener('fullscreenchange', handleChange);
      document.removeEventListener('webkitfullscreenchange', handleChange);
      if (toggleBtn) toggleBtn.removeEventListener('click', onToggleClick);
      if (exitBtn) exitBtn.removeEventListener('click', onExitClick);
    },
  };
}