require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const axios = require('axios');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const admin = require('firebase-admin');

// ===== FIREBASE ADMIN INITIALIZATION =====
let db = null;
let firebaseReady = false;

try {
  if (!admin.apps.length) {
    if (process.env.FIREBASE_PROJECT_ID) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            : undefined,
        }),
      });
    } else {
      admin.initializeApp();
    }
    console.log('[Firebase] Admin initialized');
  }

  db = admin.firestore();
  firebaseReady = true;
  console.log('[Firestore] ✅ Connected');
} catch (e) {
  console.error('[Firebase Init Error]', e.message);
  console.error('[Firebase] Bot will run but database features disabled');
}

function getDb() {
  if (!firebaseReady || !db) throw new Error('Firestore not initialized');
  return db;
}

// ===== REDIS =====
let redis;
try {
  redis = Redis.fromEnv();
  console.log('Redis connected');
} catch (e) {
  console.log('Redis not available');
  redis = null;
}

// ===== ENV =====
const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const SHORT_DOMAIN = (process.env.SHORT_DOMAIN || 'm.mayajaal.online').trim();
const BASE_URL = (process.env.BASE_URL || 'https://mayajaal.online').trim();
const PORT = parseInt(process.env.PORT || '8090', 10);
const LINK_SECRET = (process.env.LINK_SECRET || '').trim();

const APP_NAME = process.env.APP_NAME || 'MayaJaal';
const APP_SCHEME = process.env.APP_SCHEME || 'mayajaal';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.mayajaal.app';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${APP_PACKAGE}`;
const APP_STORE_URL = process.env.APP_STORE_URL || 'https://apps.apple.com/app/mayajaal/id000000000';

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('LINK_SECRET:', LINK_SECRET.length >= 20 ? 'OK' : 'MISSING/WEAK!');
console.log('APP:', APP_NAME);

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing BOT_TOKEN / API_ID / API_HASH');
if (LINK_SECRET.length < 20) throw new Error('LINK_SECRET missing or too weak (min 20 chars)');

// ===== HELPERS =====
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function signSlug(slug) {
  return crypto.createHmac('sha256', LINK_SECRET).update(slug).digest('hex').substring(0, 6);
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

// ===== RATE LIMIT =====
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
    invalid_key: '❌ Invalid key (min 12 characters)',
    rate_limit: '⚠️ <b>Rate limit exceeded</b>\n\nMax 60 links per minute.',
    language_changed: '✅ Language changed successfully!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'Current Language',
    settings_title: '⚙️ <b>Settings</b>',
    not_logged_in: '❌ <b>You are not logged in.</b>\n\nPlease use /api <YOUR_KEY> to login first.\nGet your key from the API Connect menu.',
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
    invalid_key: '❌ गलत की (कम से कम 12 अक्षर)',
    rate_limit: '⚠️ <b>रेट लिमिट पार</b>\n\n1 मिनट में 60 लिंक तक।',
    language_changed: '✅ भाषा सफलतापूर्वक बदली गई!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'वर्तमान भाषा',
    settings_title: '⚙️ <b>सेटिंग्स</b>',
    not_logged_in: '❌ <b>आप लॉग इन नहीं हैं।</b>\n\nकृपया पहले /api <YOUR_KEY> भेजें।\nAPI कनेक्ट मेन्यू से अपनी की लें।',
  },
};

function t(lang, key, vars = {}) {
  let str = (T[lang] && T[lang][key]) || T.en[key] || key;
  for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
  return str;
}
// ===== LANGUAGE HELPERS =====
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

// ===== FIREBASE USER HELPERS =====
async function getUser(userId) {
  if (!firebaseReady) return null;
  try {
    const doc = await getDb().collection('users').doc(String(userId)).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  } catch (e) {
    console.error('[FB GET USER]', e.message);
    return null;
  }
}

async function saveUser(userId, data) {
  if (!firebaseReady) return null;
  try {
    const payload = {
      username: data.username || 'user',
      joined: data.joined || Date.now(),
      balance: data.balance || 0,
      links_count: data.links_count || 0,
      clicks: data.clicks || 0,
      api_key: data.api_key || crypto.randomBytes(16).toString('hex'),
      is_logged_in: data.is_logged_in !== undefined ? data.is_logged_in : true,
    };
    await getDb().collection('users').doc(String(userId)).set(payload, { merge: true });
    return { id: String(userId), ...payload };
  } catch (e) {
    console.error('[FB SAVE USER]', e.message);
    return null;
  }
}

async function updateUser(userId, updates) {
  if (!firebaseReady) return;
  try {
    await getDb().collection('users').doc(String(userId)).set(updates, { merge: true });
  } catch (e) {
    console.error('[FB UPDATE USER]', e.message);
  }
}

async function getUserByApiKey(apiKey) {
  if (!firebaseReady) return null;
  try {
    const snapshot = await getDb().collection('users').where('api_key', '==', apiKey).limit(1).get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (e) {
    console.error('[FB GET USER BY API]', e.message);
    return null;
  }
}

// ===== FIREBASE LINK HELPERS =====
async function getLink(slug) {
  if (!firebaseReady) return null;
  try {
    const doc = await getDb().collection('links').doc(slug).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.error('[FB GET LINK]', e.message);
    return null;
  }
}

async function saveLink(slug, data) {
  if (!firebaseReady) return null;
  try {
    const payload = {
      slug,
      url: data.url,
      owner_id: String(data.owner_id),
      views: data.views || 0,
      created: data.created || Date.now(),
    };
    await getDb().collection('links').doc(slug).set(payload, { merge: true });
    return payload;
  } catch (e) {
    console.error('[FB SAVE LINK]', e.message);
    return null;
  }
}

async function updateLink(slug, updates) {
  if (!firebaseReady) return;
  try {
    await getDb().collection('links').doc(slug).set(updates, { merge: true });
  } catch (e) {
    console.error('[FB UPDATE LINK]', e.message);
  }
}

// ===== REDIS API KEY HELPERS =====
async function redisSaveUserKey(tgId, key) {
  if (!redis) return;
  try {
    await redis.set(`apikey:${tgId}`, JSON.stringify({ apiKey: key, connectedAt: Date.now() }));
  } catch (e) {}
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

// ===== CROSS-BOT SESSION =====
async function getUserKeySynced(telegramId) {
  const local = await redisGetUserKey(telegramId);
  if (local && local.apiKey) return local;

  const user = await getUser(telegramId);
  if (user && user.is_logged_in === true && user.api_key) {
    await redisSaveUserKey(telegramId, user.api_key);
    return { apiKey: user.api_key, connectedAt: Date.now() };
  }
  return null;
}

async function setUserLogin(telegramId, status, apiKey = null) {
  const updates = { is_logged_in: status };
  if (apiKey !== null) updates.api_key = apiKey;
  await updateUser(telegramId, updates);
}

// ===== SHORTEN URL =====
async function shortenUrl(longUrl, ownerId) {
  const slug = crypto.randomBytes(5).toString('hex');      // 10 chars
  const sig = signSlug(slug);                               // 6 chars
  const combined = slug + sig;                              // 16 chars total
  await saveLink(slug, { url: longUrl, owner_id: String(ownerId), views: 0, created: Date.now() });
  console.log(`[Shorten] ${slug} → user ${ownerId}`);
  return { slug, sig, combined, short: `https://${SHORT_DOMAIN}/${combined}` };
}

// ===== LANDING PAGE (App deep-link) =====
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

// ===== EXPRESS APP =====
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), firebase: firebaseReady }));

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

    const user = await getUserByApiKey(apiKey);
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    if (!checkRateLimit(user.id, 100)) return res.status(429).json({ error: 'Rate limit exceeded' });

    const result = await shortenUrl(url, user.id);
    return res.json({ success: true, short: result.short, slug: result.slug, sig: result.sig });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/:combined', async (req, res) => {
  const combined = req.params.combined;

  // Skip reserved paths
  if (combined === 'health' || combined === 'favicon.ico' || combined.startsWith('.')) {
    return res.status(404).end();
  }

  if (combined.length !== 16) return res.status(403).send('Invalid link');

  const realSlug = combined.substring(0, 10);
  const providedSig = combined.substring(10, 16);
  const expectedSig = signSlug(realSlug);

  if (providedSig !== expectedSig) return res.status(403).send('Invalid or tampered link');

  const link = await getLink(realSlug);
  if (!link) return res.status(404).send('Link not found');

  // Increment views + owner earnings
  await updateLink(realSlug, { views: (link.views || 0) + 1 });

  const user = await getUser(link.owner_id);
  if (user) {
    await updateUser(user.id, {
      balance: parseFloat(user.balance || 0) + 0.05,
      clicks: (user.clicks || 0) + 1,
    });
  }

  // Extract video ID if target is a /v/... URL
  let videoId = '';
  try {
    const m = link.url.match(/\/v\/([a-f0-9]+)/i);
    if (m) videoId = m[1];
  } catch (e) {}

  return res.send(landingPageHTML(combined, link.url, videoId));
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));
// ============================================================
// BOT MAIN
// ============================================================
(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('Bot connected!');

// ===== SET MENU BUTTON (blue button) =====
try {
  await client.invoke(new Api.bots.SetBotMenuButton({
    userId: undefined,
    button: new Api.BotMenuButton({
      text: '🔗 Open MayaJaal',
      url: `${BASE_URL}/index.html`
    })
  }));
  console.log('[Menu] ✅ Blue menu button set');
} catch (e) {
  console.error('[Menu] Menu button error:', e.message);
}

// ===== SET COMMANDS LIST (/ menu) =====
try {
  await client.invoke(new Api.bots.SetBotCommands({
    scope: new Api.BotCommandScopeDefault(),
    langCode: '',
    commands: [
      new Api.BotCommand({ command: 'start', description: '🚀 Start / Main Menu' }),
      new Api.BotCommand({ command: 'api', description: '🔑 Connect API Key' }),
      new Api.BotCommand({ command: 'help', description: '📖 Help & Support' }),
      new Api.BotCommand({ command: 'logout', description: '🚪 Logout from Bot' })
    ]
  }));
  console.log('[Menu] ✅ Commands list set');
} catch (e) {
  console.error('[Menu] Commands error:', e.message);
}
  
  // ===== KEYBOARD HELPER =====
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

  // ===== SAFE USER FETCHER (never returns null crash) =====
  async function getOrCreateUser(uid, msg = null) {
    let user = await getUser(uid);
    if (!user) {
      let username = 'user';
      if (msg) {
        try {
          const sender = await msg.getSender();
          username = sender?.username || sender?.firstName || 'user';
        } catch (e) {}
      }
      user = await saveUser(uid, { username });
    }
    // Agar Firebase fail ho gaya to safe fallback (crash nahi karega)
    if (!user) {
      user = {
        id: String(uid),
        username: 'user',
        balance: 0,
        links_count: 0,
        clicks: 0,
        api_key: '',
        is_logged_in: false,
      };
    }
    return user;
  }

  // ===== MAIN MENU =====
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
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ============================================================
  // MESSAGE HANDLER — Commands
  // ============================================================
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const text = (msg.message || '').trim();
      const uid = getSenderId(msg);
      const chatId = msg.chatId;
      const lang = await getUserLang(uid);

      // /start
      if (text === '/start') {
        await getOrCreateUser(uid, msg);
        await sendMenu(chatId, uid);
        return;
      }

      // /api <KEY>
      if (text.startsWith('/api ')) {
        const key = text.replace('/api ', '').trim();
        if (key.length < 12) {
          await client.sendMessage(chatId, { message: t(lang, 'invalid_key'), parseMode: 'html' });
          return;
        }

        const user = await getOrCreateUser(uid, msg);
        await updateUser(uid, { api_key: key, is_logged_in: true });
        await redisSaveUserKey(uid, key);

        await client.sendMessage(chatId, { message: t(lang, 'api_connected'), parseMode: 'html' });
        return;
      }

      // /logout
      if (text === '/logout') {
        await updateUser(uid, { api_key: '', is_logged_in: false });
        await redisDeleteUserKey(uid);
        await client.sendMessage(chatId, { message: t(lang, 'logout_success'), parseMode: 'html' });
        return;
      }

      // /help
      if (text === '/help' || text === '/menu') {
        await getOrCreateUser(uid, msg);
        await sendMenu(chatId, uid);
        return;
      }
    } catch (err) {
      console.error('[CMD HANDLER]', err.stack || err.message);
    }
  }, new NewMessage({}));

  // ============================================================
  // MESSAGE HANDLER — URL Conversion
  // ============================================================
  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;
      const chatId = msg.chatId;
      const text = msg.message || '';
      if (!text || text.startsWith('/')) return;

      const uid = getSenderId(msg);
      const lang = await getUserLang(uid);
      const user = await getOrCreateUser(uid, msg);

      // Session check (cross-bot)
      const sessionData = await getUserKeySynced(uid);
      if (!sessionData) {
        await client.sendMessage(chatId, { message: t(lang, 'not_logged_in'), parseMode: 'html' });
        return;
      }

      // Rate limit
      if (!checkRateLimit(uid, 60)) {
        await client.sendMessage(chatId, { message: t(lang, 'rate_limit'), parseMode: 'html' });
        return;
      }

      const urls = detectAllUrls(text);
      if (urls.length === 0) return;

      // Single URL
      if (urls.length === 1) {
        const status = await client.sendMessage(chatId, { message: t(lang, 'converting'), parseMode: 'html' });
        try {
          const result = await shortenUrl(urls[0], uid);
          await updateUser(uid, { links_count: (user.links_count || 0) + 1 });

          const report =
            t(lang, 'link_converted') + `\n\n` +
            `<b>${t(lang, 'original')}:</b>\n${escapeHtml(urls[0])}\n\n` +
            `<b>${t(lang, 'smart_link')}:</b>\n${result.short}`;

          const rows = [
            [{ text: '🔗 Open Link', url: result.short }],
            [{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }],
          ];
          await client.editMessage(chatId, {
            message: status.id,
            text: report,
            parseMode: 'html',
            buttons: keyboard(rows),
          });
        } catch (e) {
          await client.editMessage(chatId, {
            message: status.id,
            text: `❌ ${escapeHtml(e.message)}`,
            parseMode: 'html',
          });
        }
        return;
      }

      // Bulk URLs
      const status = await client.sendMessage(chatId, {
        message: t(lang, 'processing', { n: urls.length }),
        parseMode: 'html',
      });

      try {
        const CONCURRENCY = 50;
        const results = [];
        for (let i = 0; i < urls.length; i += CONCURRENCY) {
          const batch = urls.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map(url =>
              shortenUrl(url, uid)
                .then(r => ({ original: url, ...r }))
                .catch(e => ({ original: url, error: e.message }))
            )
          );
          results.push(...batchResults);
        }

        const successful = results.filter(r => !r.error);
        await updateUser(uid, { links_count: (user.links_count || 0) + successful.length });

        let reportText =
          t(lang, 'conversion_complete') + `\n\n` +
          `📊 ${t(lang, 'total')}: ${urls.length}\n` +
          `✅ ${t(lang, 'converted')}: ${successful.length}\n\n` +
          `📋 <b>${t(lang, 'sample')}:</b>\n`;

        for (let i = 0; i < Math.min(5, successful.length); i++) {
          reportText += `${i + 1}. ${successful[i].short}\n`;
        }

        await client.editMessage(chatId, {
          message: status.id,
          text: reportText,
          parseMode: 'html',
          buttons: keyboard([[{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }]]),
        });
      } catch (e) {
        await client.editMessage(chatId, {
          message: status.id,
          text: `❌ ${escapeHtml(e.message)}`,
          parseMode: 'html',
        });
      }
    } catch (err) {
      console.error('[URL HANDLER]', err.stack || err.message);
    }
  }, new NewMessage({}));
    // ============================================================
  // CALLBACK HANDLER
  // ============================================================
  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;

    try { await q.answer(); } catch (e) {}

    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const msgId = q.msgId;
    const uid = q.userId;
    const lang = await getUserLang(uid);
    const user = await getOrCreateUser(uid);

    // ---- Convert Link info ----
    if (data === 'menu_convert') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'send_link'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Bulk info ----
    if (data === 'menu_bulk') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'bulk_info'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Income (SAFE — no crash) ----
    if (data === 'menu_income') {
      const balance = parseFloat(user?.balance || 0).toFixed(2);
      const clicks = user?.clicks || 0;
      const linksCount = user?.links_count || 0;

      const text =
        `📊 <b>Aapki Income aur Views Report:</b>\n\n` +
        `💰 <b>Earnings:</b> ₹${balance}\n` +
        `👀 <b>Total Views/Clicks:</b> ${clicks}\n` +
        `🔗 <b>Total Links Generated:</b> ${linksCount}`;

      await client.editMessage(chatId, {
        message: msgId,
        text: text,
        parseMode: 'html',
        buttons: keyboard([[{ text: '« Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- View Transfer ----
    if (data === 'menu_transfer') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'view_transfer'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- All Bots ----
    if (data === 'menu_allbots') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'all_bots'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- API Connect ----
    if (data === 'menu_api') {
      const apiKey = user?.api_key || 'Not generated';
      await client.editMessage(chatId, {
        message: msgId,
        text:
          `${t(lang, 'api_connect')}\n\n` +
          `<b>${t(lang, 'your_api_key')}:</b>\n<code>${escapeHtml(apiKey)}</code>\n\n` +
          `<i>${t(lang, 'api_note')}</i>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: t(lang, 'reset_api'), callback_data: 'reset_api' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Account ----
    if (data === 'menu_account') {
      await client.editMessage(chatId, {
        message: msgId,
        text:
          `${t(lang, 'account_info')}\n\n` +
          `<b>${t(lang, 'username')}:</b> @${escapeHtml(user?.username || 'user')}\n` +
          `<b>${t(lang, 'user_id')}:</b> <code>${uid}</code>\n` +
          `<b>${t(lang, 'links')}:</b> ${user?.links_count || 0}\n` +
          `<b>${t(lang, 'clicks')}:</b> ${user?.clicks || 0}`,
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Settings ----
    if (data === 'menu_settings') {
      await client.editMessage(chatId, {
        message: msgId,
        text:
          `${t(lang, 'settings_title')}\n\n` +
          `<b>${t(lang, 'current_language')}:</b> ${lang === 'hi' ? 'हिंदी' : 'English'}`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: t(lang, 'language'), callback_data: 'menu_language' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Language selector ----
    if (data === 'menu_language') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'choose_language'),
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🇬🇧 English', callback_data: 'set_lang_en' }],
          [{ text: '🇮🇳 हिंदी', callback_data: 'set_lang_hi' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Set language ----
    if (data === 'set_lang_en' || data === 'set_lang_hi') {
      const newLang = data === 'set_lang_en' ? 'en' : 'hi';
      await saveUserLang(uid, newLang);
      await client.editMessage(chatId, {
        message: msgId,
        text: t(newLang, 'language_changed'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(newLang, 'main_menu'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Logout confirm ----
    if (data === 'menu_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'logout_confirm'),
        parseMode: 'html',
        buttons: keyboard([
          [{ text: t(lang, 'confirm'), callback_data: 'confirm_logout' }],
          [{ text: t(lang, 'cancel'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Confirm logout ----
    if (data === 'confirm_logout') {
      await updateUser(uid, { api_key: '', is_logged_in: false });
      await redisDeleteUserKey(uid);
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'logout_success'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Reset API ----
    if (data === 'reset_api') {
      const newKey = crypto.randomBytes(16).toString('hex');
      await updateUser(uid, { api_key: newKey, is_logged_in: true });
      await redisSaveUserKey(uid, newKey);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>API Reset!</b>\n\n<code>${newKey}</code>\n\n<i>${t(lang, 'api_note')}</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'back'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Main menu ----
    if (data === 'main_menu') {
      await sendMenu(chatId, uid, msgId);
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready — MayaJaal Converter (Firebase Powered)');
})();
