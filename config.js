const axios = require('axios');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

let cachedConfig = null;
let lastFetch = 0;

async function getCentralConfig(force = false) {
  if (!force && cachedConfig && Date.now() - lastFetch < 10000) {
    return cachedConfig;
  }

  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/bot_config?id=eq.1`,
      { headers: SB_HEADERS, timeout: 5000 }
    );
    cachedConfig = r.data[0] || null;
    lastFetch = Date.now();
    return cachedConfig;
  } catch (e) {
    console.error('[CONFIG] Fetch failed:', e.message);
    return cachedConfig;
  }
}

module.exports = { getCentralConfig };
