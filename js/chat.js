/* =========================================================
   js/chat.js  —  realtime room chat (render + send)
   ========================================================= */

function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function createChat({ listEl, formEl, inputEl, hintEl, onSend }) {
  let selfId = null;

  function nearBottom() {
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 90;
  }

  function scrollToBottom(force = false) {
    if (force || nearBottom()) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function buildMessage({ name, body, createdAt, mine }) {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (mine ? ' me' : '');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = mine ? 'You' : name || 'Guest';

    const text = document.createElement('span');
    text.className = 'body';
    text.textContent = body; // textContent, never innerHTML

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatClock(createdAt);

    wrap.append(who, text, time);
    return wrap;
  }

  function buildSystem(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg sys';
    wrap.textContent = text;
    return wrap;
  }

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = inputEl.value;
    const text = raw.trim();
    if (!text) return;

    inputEl.value = '';
    inputEl.style.height = '';

    try {
      await onSend(text);
    } catch (err) {
      // Put the text back so nothing is lost.
      inputEl.value = raw;
      throw err;
    }
  });

  // Keep the newest message visible when the on-screen keyboard opens.
  inputEl.addEventListener('focus', () => {
    setTimeout(() => scrollToBottom(true), 260);
  });

  return {
    setSelfId(id) {
      selfId = id;
    },

    add({ client_id, name, body, created_at }) {
      listEl.appendChild(
        buildMessage({
          name,
          body,
          createdAt: created_at,
          mine: client_id === selfId,
        })
      );
      scrollToBottom(false);
    },

    addHistory(rows) {
      listEl.replaceChildren();
      for (const row of rows) {
        listEl.appendChild(
          buildMessage({
            name: row.name,
            body: row.body,
            createdAt: row.created_at,
            mine: row.client_id === selfId,
          })
        );
      }
      scrollToBottom(true);
    },

    system(text) {
      listEl.appendChild(buildSystem(text));
      scrollToBottom(false);
    },

    setHint(text) {
      if (hintEl) hintEl.textContent = text || '';
    },

    clear() {
      listEl.replaceChildren();
    },
  };
}