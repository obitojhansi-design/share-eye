/* =========================================================
   js/app.js  —  landing page controller
   ========================================================= */

import {
  getName,
  setName,
  createRoom,
  findRoom,
  roomIsClosed,
  normalizeCode,
} from './supabase.js';

const $ = (sel) => document.querySelector(sel);

const nameInput = $('#nameInput');
const codeInput = $('#codeInput');
const createBtn = $('#createBtn');
const joinForm = $('#joinForm');
const statusEl = $('#landingStatus');
const toastEl = $('#toast');

let toastTimer = 0;

export function toast(message, ms = 2600) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function setStatus(message, ok = false) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('ok', !!ok);
}

/* ------------------------------------------------------------ restore */

nameInput.value = getName();
nameInput.addEventListener('blur', () => {
  const v = nameInput.value.trim().slice(0, 18);
  nameInput.value = v;
  setName(v);
});

codeInput.addEventListener('input', () => {
  codeInput.value = normalizeCode(codeInput.value);
});

function currentName() {
  const n = (nameInput.value || '').trim().slice(0, 18);
  if (n) setName(n);
  return n || 'Guest';
}

/* ------------------------------------------------------------- create */

createBtn.addEventListener('click', async () => {
  if (createBtn.disabled) return;
  createBtn.disabled = true;
  setStatus('Creating your room…');

  try {
    const room = await createRoom(currentName());

    // The URL is the primary channel for passing the room code to the
    // room page. Some static hosts and proxies strip query strings on
    // redirect, so we also stash the code in sessionStorage. The room
    // page reads the URL first and falls back to this if it is missing.
    try {
      sessionStorage.setItem('wt.pendingRoom', room.code);
    } catch {
      /* private mode — the URL alone is fine */
    }

    location.href = `room.html?c=${encodeURIComponent(room.code)}`;
  } catch (err) {
    setStatus(err.message || 'Could not create a room.');
    createBtn.disabled = false;
  }
});

/* --------------------------------------------------------------- join */

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const code = normalizeCode(codeInput.value);
  if (code.length !== 6) {
    setStatus('A room code is 6 characters, like K7X9P2.');
    codeInput.focus();
    return;
  }

  const btn = joinForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  setStatus('Looking for that room…');

  try {
    const room = await findRoom(code);

    if (!room) {
      setStatus('Room not found.');
      btn.disabled = false;
      codeInput.select();
      return;
    }
    if (roomIsClosed(room)) {
      setStatus('That room has already ended.');
      btn.disabled = false;
      return;
    }

    setName(currentName());

    // Same belt-and-braces hand-off as create.
    try {
      sessionStorage.setItem('wt.pendingRoom', room.code);
    } catch {
      /* ignore */
    }

    location.href = `room.html?c=${encodeURIComponent(room.code)}`;
  } catch (err) {
    setStatus(err.message || 'Could not join that room.');
    btn.disabled = false;
  }
});

/* ------------------------------------------------------- first-run hint */

if (!getName()) {
  setTimeout(() => nameInput.focus(), 250);
}