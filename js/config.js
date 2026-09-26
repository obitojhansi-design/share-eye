/* =========================================================
   js/config.js
   ---------------------------------------------------------
   Runtime configuration for a STATIC site (no bundler).
   All values live here; there is no `.env` mechanism in the
   browser, and pretending otherwise would be a lie.
   ========================================================= */

export const CONFIG = {
  // e.g. 'https://abcdefghijklm.supabase.co'
  SUPABASE_URL: 'https://fbqdpoqkbzbzvbrywaek.supabase.co',

  // Project Settings → API → "anon public"
  SUPABASE_ANON_KEY: 'sb_publishable_n-I8VgfUDnH3J35KZrLYsw_j1XTn0E5',

  // -----------------------------------------------------------
  // OPTIONAL — YouTube search inside the room.
  //
  // Get a free API key:
  //   1. console.cloud.google.com
  //   2. Create project → APIs & Services → Library
  //   3. Enable "YouTube Data API v3"
  //   4. Credentials → Create credentials → API key
  //   5. Restrict the key: "HTTP referrers" → your Vercel domain
  //
  // Free quota is 10,000 units/day. search.list costs 100 units,
  // so ~100 searches/day. Plenty for a 2–3 person room.
  //
  // Leave empty to disable in-app search: typing a query will
  // then open YouTube in a new tab instead.
  // -----------------------------------------------------------
  YOUTUBE_API_KEY: '',

  // -----------------------------------------------------------
  // Screen-share tuning.
  //  - Lower maxWidth/maxHeight → less bandwidth per peer.
  //  - Lower maxFramerate → smoother on slow networks.
  //  - maxBitrate caps the encoder; 900 kbps is a good balance
  //    for 720p-ish screen content on a home connection.
  // -----------------------------------------------------------
  SCREEN_MAX_WIDTH: 1280,
  SCREEN_MAX_HEIGHT: 720,
  SCREEN_MAX_FPS: 20,
  SCREEN_VIDEO_BITRATE: 900_000,
  SCREEN_AUDIO_BITRATE: 128_000,

  // -----------------------------------------------------------
  // Room settings
  // -----------------------------------------------------------
  ROOM_TTL_HOURS: 12,
  MAX_PARTICIPANTS: 3,
  CHAT_HISTORY: 60,
  STATE_PERSIST_MS: 8000,
  STATE_HEARTBEAT_MS: 5000,
  HOST_GRACE_MS: 90000,
  PARTICIPANT_TIMEOUT_MS: 60000,
};