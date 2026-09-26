/* =========================================================
   js/reactions.js
   ---------------------------------------------------------
   The reaction bar and the floating animation.

   The module is display-only. When a button is tapped it
   calls `onSend(emoji)` and then immediately displays the
   reaction locally, so the sender sees feedback even though
   the Supabase channel is configured with `broadcast.self:
   false` and will not echo the event back.

   Incoming reactions from other participants are displayed
   by calling `show(payload)` from room.js when the channel
   receives a `reaction` broadcast.
   ========================================================= */

const FLOAT_DURATION_MS = 3000;

export function createReactions({ barEl, layerEl, onSend }) {
  if (!barEl || !layerEl) {
    return { show() {}, destroy() {} };
  }

  function handleClick(event) {
    const btn = event.target.closest('.reaction-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    if (!emoji) return;
    onSend?.(emoji);
  }

  barEl.addEventListener('click', handleClick);

  function show(payload) {
    if (!payload || !payload.emoji) return;

    const el = document.createElement('span');
    el.className = 'reaction-float';
    el.textContent = payload.emoji;
    el.setAttribute('aria-hidden', 'true');

    // Spread across the width of the stage.
    const x = 8 + Math.random() * 84;
    el.style.left = `${x}%`;
    el.style.setProperty(
      '--drift',
      `${(Math.random() * 60 - 30).toFixed(1)}deg`
    );

    // Small size variance for a more organic feel.
    const scale = 0.9 + Math.random() * 0.3;
    el.style.fontSize = `${Math.round(36 * scale)}px`;

    layerEl.appendChild(el);

    const cleanup = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.addEventListener('animationend', cleanup, { once: true });

    // Safety net in case animationend is missed.
    setTimeout(cleanup, FLOAT_DURATION_MS + 600);
  }

  return {
    show,
    destroy() {
      barEl.removeEventListener('click', handleClick);
      layerEl.replaceChildren();
    },
  };
}