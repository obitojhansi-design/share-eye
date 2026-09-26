/* =========================================================
   js/supabase.js
   ---------------------------------------------------------
   One Supabase client + every database operation the app needs.
   Nothing else in the app talks to the database directly.
   ========================================================= */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { CONFIG } from './config.js';

export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

/* ------------------------------------------------------------ identity */

const K_ID = 'wt.clientId';
const K_NAME = 'wt.name';

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** A stable anonymous identity for this browser. No login required. */
export function getClientId() {
  let id = null;
  try { id = localStorage.getItem(K_ID); } catch { /* private mode */ }
  if (!id) {
    id = uuid();
    try { localStorage.setItem(K_ID, id); } catch { /* ignore */ }
  }
  return id;
}

export function getName() {
  try { return localStorage.getItem(K_NAME) || ''; } catch { return ''; }
}

export function setName(name) {
  try { localStorage.setItem(K_NAME, name); } catch { /* ignore */ }
}

/* ----------------------------------------------------------- room codes */

// Deliberately excludes 0/O/1/I/L so codes can be read aloud without confusion.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeRoomCode(len = 6) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/* -------------------------------------------------------- error mapping */

/** Turn raw Postgres/network errors into something a human can read. */
export function friendly(err, fallback = 'Something went wrong. Please try again.') {
  const msg = String(err?.message || err || '');
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return "Can't reach the server. Check your internet connection.";
  }
  if (/duplicate key/i.test(msg)) return 'That code is already taken.';
  if (/row-level security|permission denied/i.test(msg)) {
    return 'That action is not allowed.';
  }
  if (/JWT|apikey|Invalid API key/i.test(msg)) {
    return 'The app is not configured correctly.';
  }
  return fallback;
}

/* ---------------------------------------------------------- room writes */

/**
 * Create a room, retrying on the (very unlikely) code collision.
 * The creator becomes the host.
 */
export async function createRoom(name) {
  const clientId = getClientId();
  let lastErr = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeRoomCode();
    const { data, error } = await sb
      .from('rooms')
      .insert({ code, host_id: clientId })
      .select('*')
      .single();

    if (!error && data) {
      const { error: pErr } = await sb.from('participants').insert({
        room_id: data.id,
        client_id: clientId,
        name,
        is_host: true,
      });
      // 23505 = the participant row already exists; harmless.
      if (pErr && pErr.code !== '23505') throw new Error(friendly(pErr));
      return data;
    }

    lastErr = error;
    // Only keep retrying on a genuine code collision.
    if (error && error.code !== '23505') break;
  }

  throw new Error(friendly(lastErr, 'Could not create a room. Please try again.'));
}

export async function findRoom(code) {
  const { data, error } = await sb
    .from('rooms')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(friendly(error, 'Could not check that room code.'));
  return data || null;
}

export function roomIsClosed(room) {
  if (!room) return true;
  if (room.closed_at) return true;
  if (new Date(room.expires_at).getTime() < Date.now()) return true;
  return false;
}

export async function joinRoom(room, name) {
  const clientId = getClientId();
  const { data, error } = await sb
    .from('participants')
    .upsert(
      {
        room_id: room.id,
        client_id: clientId,
        name,
        is_host: room.host_id === clientId,
        joined_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      },
      { onConflict: 'room_id,client_id' }
    )
    .select('*')
    .single();
  if (error) throw new Error(friendly(error, 'Could not join that room.'));
  return data;
}

export async function leaveRoom(roomId, clientId) {
  const { error } = await sb
    .from('participants')
    .delete()
    .eq('room_id', roomId)
    .eq('client_id', clientId);
  return !error;
}

export async function touchParticipant(roomId, clientId) {
  await sb
    .from('participants')
    .update({ last_seen: new Date().toISOString() })
    .eq('room_id', roomId)
    .eq('client_id', clientId);
}

export async function closeRoom(roomId) {
  await sb
    .from('rooms')
    .update({
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', roomId);
}

/**
 * Clear `closed_at` on a room the host wants to reopen.
 * Only succeeds while the room has not yet expired, because the RLS
 * update policy requires `expires_at > now()`.
 */
export async function reopenRoom(roomId) {
  const { error } = await sb
    .from('rooms')
    .update({
      closed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', roomId);
  if (error) throw new Error(friendly(error, 'Could not reopen the room.'));
  return true;
}

/**
 * Persist the watch state so late joiners know what is playing.
 * Called on a throttle — never per animation frame.
 */
export async function persistState(roomId, state) {
  await sb
    .from('rooms')
    .update({ state, updated_at: new Date().toISOString() })
    .eq('id', roomId);
}

/* --------------------------------------------------------------- chat */

export async function loadRecentMessages(roomId, limit = CONFIG.CHAT_HISTORY) {
  const { data, error } = await sb
    .from('messages')
    .select('id, client_id, name, body, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data.reverse(); // oldest → newest for rendering
}

export async function sendMessage(roomId, clientId, name, body) {
  const clean = String(body || '').trim().slice(0, 600);
  if (!clean) return;
  const { error } = await sb.from('messages').insert({
    room_id: roomId,
    client_id: clientId,
    name,
    body: clean,
  });
  if (error) throw new Error(friendly(error, 'Message could not be sent.'));
}

/* --------------------------------------------- fire-and-forget beacon */

/**
 * Kept for potential future use, but no longer called from `pagehide`.
 * Sending a close beacon on page unload turned out to close rooms the
 * host was only navigating away from temporarily. See README §7.
 */
export function beacon(url, body) {
  try {
    fetch(url, {
      method: 'PATCH',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
  } catch { /* best effort only */ }
}

export function beaconCloseRoom(roomId) {
  beacon(`${CONFIG.SUPABASE_URL}/rest/v1/rooms?id=eq.${roomId}`, {
    closed_at: new Date().toISOString(),
  });
}