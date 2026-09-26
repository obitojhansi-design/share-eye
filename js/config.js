/* =========================================================
   js/config.js
   ---------------------------------------------------------
   Runtime configuration.

   This project is a STATIC site (no bundler), so there is no
   build step that can inline `.env` values into the browser.
   Putting secrets in a `.env` file would simply do nothing here.
   Therefore `js/config.js` is the single source of truth.

   SAFE to ship in client code:
     - the Supabase project URL
     - the Supabase anon (public) key
   These are protected by Row Level Security, not by secrecy.

   NEVER ship in client code:
     - the Supabase service_role key
     - any database password
   ========================================================= */

export const CONFIG = {
  // e.g. 'https://abcdefghijklm.supabase.co'
  SUPABASE_URL: 'https://fbqdpoqkbzbzvbrywaek.supabase.co',

  // Project Settings → API → "anon public"
  SUPABASE_ANON_KEY: 'sb_publishable_n-I8VgfUDnH3J35KZrLYsw_j1XTn0E5',

  // How long a room may live before it is considered expired.
  ROOM_TTL_HOURS: 12,

  // Hard cap. This app is designed for 2–3 people, not a crowd.
  MAX_PARTICIPANTS: 3,

  // How many past chat messages to load when joining.
  CHAT_HISTORY: 60,

  // How often the host persists the watch state to the database.
  // (Live sync uses Realtime broadcast; the DB copy is only so that
  //  someone joining late knows what is currently playing.)
  STATE_PERSIST_MS: 8000,

  // How often the host re-broadcasts the current position while playing.
  STATE_HEARTBEAT_MS: 5000,

  // If the host vanishes, wait this long before ending the session.
  HOST_GRACE_MS: 90000,

  // A participant not seen for this long is dropped from the list.
  PARTICIPANT_TIMEOUT_MS: 60000,
};