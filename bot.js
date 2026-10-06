require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const { getCentralConfig } = require('./config');

let redis;
try { redis = Redis.fromEnv(); console.log('Redis connected'); } catch (e) { console.log('Redis not available'); redis = null; }

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const SHORT_DOMAIN = (process.env.SHORT_DOMAIN || 'm.mayajaal.online').trim();
const BASE_URL = (process.env.BASE_URL || 'https://mayajaal.online').trim();
const PORT = parseInt(process.env.PORT || '8090', 10);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const LINK_SECRET = (process.env.LINK_SECRET || 'CHANGE-THIS-NOW-TO-RANDOM-32-CHARS').trim();

const APP_NAME = process.env.APP_NAME || 'MayaJaal';
const APP_SCHEME = process.env.APP_SCHEME || 'mayajaal';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.mayajaal.app';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${APP_PACKAGE}`;
const APP_STORE_URL = process.env.APP_STORE_URL || 'https://apps.apple.com/app/mayajaal/id000000000';

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('SUPABASE:', !!SUPABASE_URL, !!SUPABASE_KEY);
console.log('LINK_SECRET:', LINK_SECRET.length >= 20 ? 'OK' : 'WEAK!');
console.log('APP:', APP_NAME);

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing credentials');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase config');
if (LINK_SECRET.length < 20) throw new Error('LINK_SECRET too weak');

// ===== TRANSLATIONS =====
const T = {
  en: {
    welcome: '👋 <b>Welcome to MayaJaal.online</b>\n<i>Link Shortener • Convert • Earn</i>\n\n✅ Convert links\n✅ Bulk converter (1000+ links)\n✅ Fast & Secure',
    convert: '🔗 Convert Link', bulk: '🗂 Bulk Converter',
    income: '💰 Income', transfer: '📊 View Transfer',
    allbots: '🤖 All Bots', api: '🔌 API Connect',
    account: '👤 Account', logout: '🚪 Logout',
    settings: '⚙️ Settings', language: '🌐 Language',
    main_menu: '⬅️ Main Menu', back: '⬅️ Back', confirm: '✅ Confirm', cancel: '❌ Cancel',
    send_link: '🔗 <b>Convert Link</b>\n\nSend a link, I will make a smart short link.',
    bulk_info: '🗂 <b>Bulk Link Converter</b>\n\nSend 1000+ links (one per line).',
    your_income: '💰 <b>Your Income</b>',
    earnings: 'Total Earnings', clicks: 'Clicks', links: 'Links',
    view_transfer: '📊 <b>View Transfer</b>\n\nNo transfers yet.',
    all_bots: '🤖 <b>All Bots</b>\n\n🔗 Link Converter (Active)\n🎬 Video Bot (Active)',
    api_connect: '🔌 <b>API Connect</b>',
    your_api_key: 'Your API Key',
    api_note: 'This key works on both bots.',
    api_docs: '📖 API Docs',
    reset_api: '🔄 Reset API',
    privacy: '🛡️ Privacy',
    account_info: '👤 <b>Account</b>',
    username: 'Username', user_id: 'User ID',
    logout_confirm: '🚪 <b>Logout</b>\n\nConfirm?',
    logout_success: '✅ Logout successful. Logged out from both bots.',
    link_converted: '✅ <b>Link Converted!</b>',
    original: 'Original', smart_link: 'Smart Link',
    converting: '⚡ <i>Converting...</i>',
    processing: '⏳ <b>Processing {n} links...</b>',
    conversion_complete: '✅ <b>Conversion Complete!</b>',
    total: 'Total', converted: 'Converted', time: 'Time', sample: 'Sample',
    api_connected: '✅ <b>API Key Connected!</b>\n\nNow works on both bots. Send a video or link.',
    invalid_key: '❌ Invalid key',
    rate_limit: '⚠️ <b>Rate limit exceeded</b>\n\nMax 60 links per minute.',
    language_changed: '✅ Language changed successfully!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'Current Language',
    settings_title: '⚙️ <b>Settings</b>'
  },
  hi: {
    welcome: '👋 <b>MayaJaal.online में आपका स्वागत है</b>\n<i>लिंक शॉर्टनर • कन्वर्ट • कमाई</i>\n\n✅ लिंक कन्वर्ट करें\n✅ बल्क कन्वर्टर (1000+ लिंक)\n✅ तेज़ और सुरक्षित',
    convert: '🔗 लिंक कन्वर्ट', bulk: '🗂 बल्क कन्वर्टर',
    income: '💰 कमाई', transfer: '📊 ट्रांसफर देखें',
    allbots: '🤖 सभी बॉट्स', api: '🔌 API कनेक्ट',
    account: '👤 अकाउंट', logout: '🚪 लॉगआउट',
    settings: '⚙️ सेटिंग्स', language: '🌐 भाषा',
    main_menu: '⬅️ मुख्य मेन्यू', back: '⬅️ वापस', confirm: '✅ पक्का करें', cancel: '❌ रद्द करें',
    send_link: '🔗 <b>लिंक कन्वर्ट</b>\n\nलिंक भेजें, मैं स्मार्ट शॉर्ट लिंक बनाऊंगा।',
    bulk_info: '🗂 <b>बल्क लिंक कन्वर्टर</b>\n\n1000+ लिंक भेजें (एक लाइन में एक)।',
    your_income: '💰 <b>आपकी कमाई</b>',
    earnings: 'कुल कमाई', clicks: 'क्लिक', links: 'लिंक',
    view_transfer: '📊 <b>ट्रांसफर देखें</b>\n\nअभी कोई ट्रांसफर नहीं।',
    all_bots: '🤖 <b>सभी बॉट्स</b>\n\n🔗 लिंक कन्वर्टर (सक्रिय)\n🎬 वीडियो बॉट (सक्रिय)',
    api_connect: '🔌 <b>API कनेक्ट</b>',
    your_api_key: 'आपकी API की',
    api_note: 'यह की दोनों बॉट्स में काम करेगी।',
    api_docs: '📖 API डॉक्स',
    reset_api: '🔄 API रीसेट',
    privacy: '🛡️ प्राइवेसी',
    account_info: '👤 <b>अकाउंट</b>',
    username: 'यूज़रनेम', user_id: 'यूज़र ID',
    logout_confirm: '🚪 <b>लॉगआउट</b>\n\nपक्का करें?',
    logout_success: '✅ लॉगआउट सफल। दोनों बॉट्स से लॉगआउट हो गया।',
    link_converted: '✅ <b>लिंक कन्वर्ट हो गया!</b>',
    original: 'मूल लिंक', smart_link: 'स्मार्ट लिंक',
    converting: '⚡ <i>कन्वर्ट हो रहा है...</i>',
    processing: '⏳ <b>{n} लिंक प्रोसेस हो रहे हैं...</b>',
    conversion_complete: '✅ <b>कन्वर्ज़न पूरा!</b>',
    total: 'कुल', converted: 'कन्वर्ट', time: 'समय', sample: 'नमूना',
    api_connected: '✅ <b>API की कनेक्ट हो गई!</b>\n\nअब दोनों बॉट्स में काम करेगी।',
    invalid_key: '❌ गलत की',
    rate_limit: '⚠️ <b>रेट लिमिट पार</b>\n\n1 मिनट में 60 लिंक तक।',
    language_changed: '✅ भाषा सफलतापूर्वक बदली गई!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'वर्तमान भाषा',
    settings_title: '⚙️ <b>सेटिंग्स</b>'
  }
};

function t(lang, key, vars = {}) {
  let str = (T[lang] && T[lang][key]) || T.en[key] || key;
  for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
  return str;
}

async function getUserLang(tgId) {
  if (!redis) return 'en';
  try {
    const raw = await redis.get(`lang:${tgId}`);
    if (raw) return typeof raw === 'string' ? raw.replace(/"/g, '') : 'en';
  } catch (e) {}
  return 'en';
}
async function saveUserLang(tgId, lang) {
  if (!redis) return;
  try { await redis.set(`lang:${tgId}`, lang); } catch (e) {}
}

function signSlug(slug) {
  return crypto.createHmac('sha256', LINK_SECRET).update(slug).digest('hex').substring(0, 6);
}

const SB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function sbGet(table, query = '') {
  try {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/${table}${query}`, { headers: SB_HEADERS, timeout: 10000 });
    return r.data || [];
  } catch (e) { console.error('[SB GET]', e.message); return []; }
}

async function sbUpsert(table, data, conflictCol = 'id') {
  try {
    const r = await axios.post(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictCol}`, data, {
      headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      timeout: 10000,
    });
    return r.data;
  } catch (e) { console.error('[SB UPSERT]', e.response ? e.response.data : e.message); return null; }
}

async function sbPatch(table, query, data) {
  try {
    const r = await axios.patch(`${SUPABASE_URL}/rest/v1/${table}${query}`, data, { headers: SB_HEADERS, timeout: 10000 });
    return r.data;
  } catch (e) { console.error('[SB PATCH]', e.message); return null; }
}

async function redisSaveUserKey(tgId, key) {
  if (!redis) return;
  try { await redis.set(`apikey:${tgId}`, JSON.stringify({ apiKey: key, connectedAt: Date.now() })); } catch (e) {}
}
async function redisDeleteUserKey(tgId) {
  if (!redis) return;
  try { await redis.del(`apikey:${tgId}`); } catch (e) {}
}
async function redisGetUserKey(tgId) {
  if (!redis) return null;
  try {
    const raw = await redis.get(`apikey:${tgId}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return null; }
}

async function getUser(userId) {
  const rows = await sbGet('users', `?id=eq.${encodeURIComponent(userId)}&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function saveUser(userId, data) {
  const payload = {
    id: String(userId), username: data.username || 'user',
    joined: data.joined || Date.now(), balance: data.balance || 0,
    links_count: data.links_count || 0, clicks: data.clicks || 0,
    api_key: data.api_key,
  };
  return sbUpsert('users', payload, 'id');
}

async function createUser(userId, username) {
  const user = {
    id: String(userId), username: username || 'user', joined: Date.now(),
    balance: 0, links_count: 0, clicks: 0,
    api_key: crypto.randomBytes(16).toString('hex'),
  };
  await saveUser(userId, user);
  return user;
}
async function getLink(slug) {
  const rows = await sbGet('links', `?slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function saveLink(slug, data) {
  const payload = {
    slug, url: data.url, owner_id: String(data.owner_id),
    views: data.views || 0, created: data.created || Date.now(),
  };
  return sbUpsert('links', payload, 'slug');
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getSenderId(msg) {
  return msg.senderId || (msg.fromId && msg.fromId.userId) || (msg.sender && msg.sender.id) || 0;
}

function detectAllUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>()"'`]+/gi) || [];
  const seen = new Set();
  const unique = [];
  for (const u of matches) {
    const clean = u.replace(/[.,;:!?]+$/, '');
    if (!seen.has(clean)) { seen.add(clean); unique.push(clean); }
  }
  return unique;
}

function getDomainName(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch (e) { return 'Unknown'; }
}

const rateLimitMap = new Map();
function checkRateLimit(userId, maxPerMin = 60) {
  const now = Date.now();
  const key = String(userId);
  const entry = rateLimitMap.get(key) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count <= maxPerMin;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) if (now > v.reset) rateLimitMap.delete(k);
}, 120000);

async function shortenUrl(longUrl, ownerId) {
  const slug = crypto.randomBytes(5).toString('hex');
  const sig = signSlug(slug);
  const combined = slug + sig;
  await saveLink(slug, { url: longUrl, owner_id: String(ownerId), views: 0, created: Date.now() });
  return { slug, sig, combined, short: `https://${SHORT_DOMAIN}/${combined}` };
}

function landingPageHTML(combined, targetUrl, videoId) {
  const androidIntent = `intent://watch?v=${videoId}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const iosScheme = `${APP_SCHEME}://watch?v=${videoId}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${APP_NAME} - Opening...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.logo{font-size:48px;font-weight:800;background:linear-gradient(135deg,#00ff88,#00b4ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px}
.spinner{width:64px;height:64px;border:4px solid #1a1a1a;border-top-color:#00ff88;border-radius:50%;animation:spin 1s linear infinite;margin:32px auto}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:16px;color:#888;margin:16px 0}
.btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#00ff88,#00b4ff);color:#000;text-decoration:none;border-radius:10px;font-weight:700;margin:8px;font-size:15px}
.btn-secondary{background:#1a1a1a;color:#fff;border:1px solid #333}
.actions{margin-top:24px}
</style>
</head>
<body>
<div class="logo">🎬 ${APP_NAME}</div>
<div class="spinner"></div>
<div class="msg" id="msg">Opening in app...</div>
<div class="actions" id="actions" style="display:none">
  <a href="${PLAY_STORE_URL}" class="btn">📲 Download App</a>
  <a href="${targetUrl}" class="btn btn-secondary">🌐 Watch in Browser</a>
</div>
<script>
(function() {
  var ua = navigator.userAgent || '';
  var isAndroid = /android/i.test(ua);
  var isIOS = /iphone|ipad|ipod/i.test(ua);
  var appOpened = false;
  document.addEventListener('visibilitychange', function() { if (document.hidden) appOpened = true; });
  window.addEventListener('blur', function() { appOpened = true; });
  function showFallback() {
    if (appOpened) return;
    document.getElementById('msg').innerHTML = 'App not installed?<br><small style="color:#666">Download to watch faster</small>';
    document.getElementById('actions').style.display = 'block';
  }
  if (isAndroid) {
    window.location.href = '${androidIntent}';
    setTimeout(showFallback, 2500);
  } else if (isIOS) {
    window.location.href = '${iosScheme}';
    setTimeout(function() {
      if (!appOpened) window.location.href = '${APP_STORE_URL}';
      setTimeout(showFallback, 2000);
    }, 2000);
  } else {
    document.getElementById('msg').innerHTML = 'Open this link on mobile to use the app';
    document.getElementById('actions').style.display = 'block';
  }
})();
</script>
</body>
</html>`;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').send(JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: APP_PACKAGE,
      sha256_cert_fingerprints: [(process.env.APP_SHA256 || 'REPLACE_WITH_YOUR_SHA256')],
    },
  }], null, 2));
});

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    applinks: {
      apps: [],
      details: [{ appID: (process.env.APPLE_TEAM_ID || 'TEAMID') + '.' + APP_PACKAGE, paths: ['*'] }],
    },
  }, null, 2));
});

app.post('/api/shorten', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const url = req.body.url;
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const users = await sbGet('users', `?api_key=eq.${encodeURIComponent(apiKey)}&limit=1`);
    const user = users && users[0];
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    if (!checkRateLimit(user.id, 100)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const result = await shortenUrl(url, user.id);
    return res.json({ success: true, short: result.short, slug: result.slug, sig: result.sig });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/:combined', async (req, res) => {
  const combined = req.params.combined;
  if (combined === 'health') return res.json({ ok: true });
  if (combined.length !== 16) return res.status(403).send('Invalid link');
  const realSlug = combined.substring(0, 10);
  const providedSig = combined.substring(10, 16);
  const expectedSig = signSlug(realSlug);
  if (providedSig !== expectedSig) return res.status(403).send('Invalid or tampered link');
  const link = await getLink(realSlug);
  if (!link) return res.status(404).send('Link not found');
  await sbPatch('links', `?slug=eq.${encodeURIComponent(realSlug)}`, { views: (link.views || 0) + 1 });
  const user = await getUser(link.owner_id);
  if (user) {
    await sbPatch('users', `?id=eq.${encodeURIComponent(user.id)}`, {
      balance: parseFloat(user.balance || 0) + 0.05,
      clicks: (user.clicks || 0) + 1,
    });
  }
  let videoId = '';
  try { const m = link.url.match(/\/v\/([a-f0-9]+)/i); if (m) videoId = m[1]; } catch (e) {}
  return res.send(landingPageHTML(combined, link.url, videoId));
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));

async function waitForApiConnection() {
  console.log('[BOT] Waiting for central API connection...');
  while (true) {
    const cfg = await getCentralConfig();
    if (cfg && cfg.api_connected === true) {
      console.log('[BOT] ✅ Central API Connected:', cfg.api_base);
      return cfg;
    }
    console.log('[BOT] ⏳ Not connected yet. Retrying in 10s...');
    await new Promise(r => setTimeout(r, 10000));
  }
  }
(async () => {
  await waitForApiConnection();

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5, autoReconnect: true,
  });
  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('Bot connected!');

  function keyboard(rows) {
    return new Api.ReplyInlineMarkup({
      rows: rows.map(row => new Api.KeyboardButtonRow({
        buttons: row.map(btn => {
          if (btn.url) return new Api.KeyboardButtonUrl({ text: btn.text, url: btn.url });
          return new Api.KeyboardButtonCallback({ text: btn.text, data: Buffer.from(btn.callback_data || '') });
        }),
      })),
    });
  }

  async function sendMenu(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = t(lang, 'welcome');
    const rows = [
      [{ text: t(lang, 'convert'), callback_data: 'menu_convert' }, { text: t(lang, 'bulk'), callback_data: 'menu_bulk' }],
      [{ text: t(lang, 'income'), callback_data: 'menu_income' }, { text: t(lang, 'transfer'), callback_data: 'menu_transfer' }],
      [{ text: t(lang, 'allbots'), callback_data: 'menu_allbots' }, { text: t(lang, 'api'), callback_data: 'menu_api' }],
      [{ text: t(lang, 'account'), callback_data: 'menu_account' }, { text: t(lang, 'settings'), callback_data: 'menu_settings' }],
      [{ text: t(lang, 'logout'), callback_data: 'menu_logout' }],
    ];
    if (editMsgId) {
      try { await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) }); return; } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const text = (msg.message || '').trim();
    const uid = getSenderId(msg);
    const chatId = msg.chatId;

    if (text === '/start') {
      let user = await getUser(uid);
      if (!user) { const sender = await msg.getSender(); user = await createUser(uid, sender?.username || sender?.firstName || 'user'); }
      await sendMenu(chatId, uid);
      return;
    }

    if (text.startsWith('/api ')) {
      const key = text.replace('/api ', '').trim();
      const lang = await getUserLang(uid);
      if (key.length < 12) { await client.sendMessage(chatId, { message: t(lang, 'invalid_key'), parseMode: 'html' }); return; }
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { api_key: key });
      await redisSaveUserKey(uid, key);
      await client.sendMessage(chatId, { message: t(lang, 'api_connected'), parseMode: 'html' });
      return;
    }

    if (text === '/logout') {
      const lang = await getUserLang(uid);
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { api_key: '' });
      await redisDeleteUserKey(uid);
      await client.sendMessage(chatId, { message: t(lang, 'logout_success'), parseMode: 'html' });
      return;
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const chatId = msg.chatId;
    const text = msg.message || '';
    if (!text || text.startsWith('/')) return;
    const uid = getSenderId(msg);
    const lang = await getUserLang(uid);
    let user = await getUser(uid);
    if (!user) { const sender = await msg.getSender(); user = await createUser(uid, sender?.username || 'user'); }
    if (!checkRateLimit(uid, 60)) { return client.sendMessage(chatId, { message: t(lang, 'rate_limit'), parseMode: 'html' }); }
    const urls = detectAllUrls(text);
    if (urls.length === 0) return;

    if (urls.length === 1) {
      const status = await client.sendMessage(chatId, { message: t(lang, 'converting'), parseMode: 'html' });
      try {
        const result = await shortenUrl(urls[0], uid);
        await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { links_count: (user.links_count || 0) + 1 });
        const report = t(lang, 'link_converted') + `\n\n` +
          `<b>${t(lang, 'original')}:</b>\n${escapeHtml(urls[0])}\n\n` +
          `<b>${t(lang, 'smart_link')}:</b>\n${result.short}`;
        const rows = [
          [{ text: '🔗 Open Link', url: result.short }],
          [{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }],
        ];
        await client.editMessage(chatId, { message: status.id, text: report, parseMode: 'html', buttons: keyboard(rows) });
      } catch (e) { await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` }); }
      return;
    }

    const status = await client.sendMessage(chatId, { message: t(lang, 'processing', { n: urls.length }), parseMode: 'html' });
    try {
      const CONCURRENCY = 50;
      const results = [];
      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(url => shortenUrl(url, uid).then(r => ({ original: url, ...r })).catch(e => ({ original: url, error: e.message }))));
        results.push(...batchResults);
      }
      const successful = results.filter(r => !r.error);
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { links_count: (user.links_count || 0) + successful.length });
      let reportText = t(lang, 'conversion_complete') + `\n\n` +
        `📊 ${t(lang, 'total')}: ${urls.length}\n` +
        `✅ ${t(lang, 'converted')}: ${successful.length}\n\n` +
        `📋 <b>${t(lang, 'sample')}:</b>\n`;
      for (let i = 0; i < Math.min(5, successful.length); i++) reportText += `${i + 1}. ${successful[i].short}\n`;
      await client.editMessage(chatId, { message: status.id, text: reportText, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }]]) });
    } catch (e) { await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` }); }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const msgId = q.msgId;
    try { await q.answer(); } catch (e) {}
    const uid = q.userId;
    const lang = await getUserLang(uid);
    let user = await getUser(uid);
    if (!user) user = await createUser(uid, 'user');

    if (data === 'menu_convert') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'send_link'), parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_bulk') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'bulk_info'), parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_income') {
      const balance = parseFloat(user.balance || 0).toFixed(2);
      await client.editMessage(chatId, { message: msgId, text: `${t(lang, 'your_income')}\n\n<b>${t(lang, 'earnings')}:</b> ₹${balance}\n<b>${t(lang, 'clicks')}:</b> ${user.clicks || 0}\n<b>${t(lang, 'links')}:</b> ${user.links_count || 0}`, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_transfer') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'view_transfer'), parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_allbots') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'all_bots'), parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_api') {
      await client.editMessage(chatId, { message: msgId, text: `${t(lang, 'api_connect')}\n\n<b>${t(lang, 'your_api_key')}:</b>\n<code>${user.api_key}</code>\n\n<i>${t(lang, 'api_note')}</i>`, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'reset_api'), callback_data: 'reset_api' }], [{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_account') {
      await client.editMessage(chatId, { message: msgId, text: `${t(lang, 'account_info')}\n\n<b>${t(lang, 'username')}:</b> @${user.username}\n<b>${t(lang, 'user_id')}:</b> ${user.id}\n<b>${t(lang, 'links')}:</b> ${user.links_count || 0}\n<b>${t(lang, 'clicks')}:</b> ${user.clicks || 0}`, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_settings') {
      await client.editMessage(chatId, { message: msgId, text: `${t(lang, 'settings_title')}\n\n<b>${t(lang, 'current_language')}:</b> ${lang === 'hi' ? 'हिंदी' : 'English'}`, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'language'), callback_data: 'menu_language' }], [{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_language') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'choose_language'), parseMode: 'html', buttons: keyboard([[{ text: '🇬🇧 English', callback_data: 'set_lang_en' }], [{ text: '🇮🇳 हिंदी', callback_data: 'set_lang_hi' }], [{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'set_lang_en' || data === 'set_lang_hi') {
      const newLang = data === 'set_lang_en' ? 'en' : 'hi';
      await saveUserLang(uid, newLang);
      await client.editMessage(chatId, { message: msgId, text: t(newLang, 'language_changed'), parseMode: 'html', buttons: keyboard([[{ text: t(newLang, 'main_menu'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'menu_logout') {
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'logout_confirm'), parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'confirm'), callback_data: 'confirm_logout' }], [{ text: t(lang, 'cancel'), callback_data: 'main_menu' }]]) });
      return;
    }
    if (data === 'confirm_logout') {
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { api_key: '' });
      await redisDeleteUserKey(uid);
      await client.editMessage(chatId, { message: msgId, text: t(lang, 'logout_success'), parseMode: 'html' });
      return;
    }
    if (data === 'main_menu') { await sendMenu(chatId, uid, msgId); return; }
    if (data === 'reset_api') {
      const newKey = crypto.randomBytes(16).toString('hex');
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { api_key: newKey });
      await client.editMessage(chatId, { message: msgId, text: `✅ <b>API Reset!</b>\n\n<code>${newKey}</code>`, parseMode: 'html', buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]) });
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready - MayaJaal Converter (Hindi/English)');
})();
