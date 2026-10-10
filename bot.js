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
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (e) => console.error('[Uncaught]', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e.message));

// ===== FIREBASE ADMIN INITIALIZATION (Firestore + Realtime DB) =====
let db = null;
let rtdb = null;
let firebaseReady = false;

const RTDB_URL = (process.env.RTDB_URL || 'https://mayajaal-app-default-rtdb.asia-southeast1.firebasedatabase.app').trim();

try {
  if (!admin.apps.length) {
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyPath)) {
      throw new Error('Service account JSON not found: ' + keyPath);
    }
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
      databaseURL: RTDB_URL,
    });
    console.log('[Firebase] Admin initialized');
  }

  db = admin.firestore();
  rtdb = admin.database();
  firebaseReady = true;
  console.log('[Firestore] ✅ Connected');
  console.log('[RTDB] ✅ Connected —', RTDB_URL);
} catch (e) {
  console.error('[Firebase Init Error]', e.message);
  console.error('[Firebase] Bot will run but database features disabled');
}

function getDb() {
  if (!firebaseReady || !db) throw new Error('Firestore not initialized');
  return db;
}
function getRTDB() {
  if (!firebaseReady || !rtdb) throw new Error('RTDB not initialized');
  return rtdb;
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
// ⭐ CHANGED: default www.mayajaal.online
const SHORT_DOMAIN = (process.env.SHORT_DOMAIN || 'www.mayajaal.online').trim();
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
console.log('SHORT_DOMAIN:', SHORT_DOMAIN);
console.log('BASE_URL:', BASE_URL);

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing BOT_TOKEN / API_ID / API_HASH');
if (LINK_SECRET.length < 20) throw new Error('LINK_SECRET missing or too weak (min 20 chars)');

// ===== BASIC HELPERS =====
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

function round2(n) { return Math.round(n * 100) / 100; }

// ===== EARNINGS MATH (same as website) =====
function calcEarnings(views) {
  views = Math.max(0, Number(views) || 0);
  if (views <= 0) return 0;
  if (views <= 1000) return round2((views / 1000) * 1);
  var income = 1;
  var remaining = views - 1000;
  var tier = 1;
  while (remaining > 0) {
    var chunk = Math.min(remaining, 2000);
    income += (chunk / 1000) * Math.pow(1.5, tier);
    remaining -= chunk;
    tier++;
    if (tier > 30) break;
  }
  return round2(income);
}
function getTierInfo(views) {
  views = Math.max(0, Number(views) || 0);
  if (views < 1000) return { tier: 1, rate: 1.00, from: 0, to: 1000, next: 1000 - views };
  var tier = 1, start = 1000;
  while (views >= start + 2000) { tier++; start += 2000; if (tier > 30) break; }
  return {
    tier: tier + 1,
    rate: round2(Math.pow(1.5, tier)),
    from: start,
    to: start + 2000,
    next: start + 2000 - views,
  };
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

// ============================================================
// TRANSLATIONS — EN + HI (Extended with stats/earnings)
// ============================================================
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
    api_key_not_found: '❌ Invalid API Key.\n\nLogin on website and copy fresh key:\n' + BASE_URL,
    rate_limit: '⚠️ <b>Rate limit exceeded</b>\n\nMax 60 links per minute.',
    language_changed: '✅ Language changed successfully!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'Current Language',
    settings_title: '⚙️ <b>Settings</b>',
    not_logged_in: '❌ <b>You are not logged in.</b>\n\nPlease use /api <YOUR_KEY> to login first.\nGet your key from the API Connect menu.',

    // ===== STATS STRINGS =====
    btn_stats: 'My Stats', btn_mylinks: 'My Links', btn_earnings: 'Earnings', btn_help: 'Help',
    stats_title: 'MAYAJAAL STATS',
    stats_email: 'Email',
    stats_links: 'Total Links',
    stats_views: 'Total Views',
    stats_today: 'Today Views',
    stats_income: 'Total Income',
    stats_rate: 'Current Rate',
    stats_tier: 'Current Tier',
    stats_next_boost: 'Next Boost',
    stats_base: 'Base',
    stats_bonus: 'Bonus',
    stats_synced: 'Real-time data synced from website',
    stats_no_links: 'No links yet. Convert a link to get started.',
    stats_your_links: 'YOUR LAST 10 LINKS',
    stats_tap_copy: 'Tap link → copy → share',
    stats_your_views: 'Your Views',
    stats_your_income: 'Your Income',
    stats_your_tier: 'Your Tier',
    stats_withdraw: 'Withdrawal',
    stats_withdraw_info: 'Min $20 · Bank/UPI',
    stats_processing: 'Processing',
    stats_processing_info: '24–48 hours',
    earnings_title: 'MAYAJAAL EARNINGS MODEL',
    earnings_base: 'Base Rate',
    earnings_bonus: 'Bonus',
    earnings_bonus_text: 'Every extra 2,000 views → rate × 1.5 (50% boost)',
    earnings_tier_table: 'TIER TABLE',
    earnings_example: 'EXAMPLE (5K views)',
    earnings_example_total: 'Total',
    your_stats_title: 'YOUR STATS',
    connect_required: 'Connect API first to see stats',
    open_website: 'Open Website',
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
    api_key_not_found: '❌ गलत API की।\n\nवेबसाइट पर लॉगिन करके नई की कॉपी करें:\n' + BASE_URL,
    rate_limit: '⚠️ <b>रेट लिमिट पार</b>\n\n1 मिनट में 60 लिंक तक।',
    language_changed: '✅ भाषा सफलतापूर्वक बदली गई!',
    choose_language: '🌐 <b>Choose Language / भाषा चुनें</b>',
    current_language: 'वर्तमान भाषा',
    settings_title: '⚙️ <b>सेटिंग्स</b>',
    not_logged_in: '❌ <b>आप लॉग इन नहीं हैं।</b>\n\nकृपया पहले /api <YOUR_KEY> भेजें।\nAPI कनेक्ट मेन्यू से अपनी की लें।',

    // ===== STATS STRINGS =====
    btn_stats: 'मेरे स्टैट्स', btn_mylinks: 'मेरे लिंक', btn_earnings: 'कमाई', btn_help: 'मदद',
    stats_title: 'मायाजाल स्टैट्स',
    stats_email: 'ईमेल',
    stats_links: 'कुल लिंक',
    stats_views: 'कुल व्यूज़',
    stats_today: 'आज के व्यूज़',
    stats_income: 'कुल कमाई',
    stats_rate: 'वर्तमान रेट',
    stats_tier: 'वर्तमान टियर',
    stats_next_boost: 'अगला बूस्ट',
    stats_base: 'बेस',
    stats_bonus: 'बोनस',
    stats_synced: 'वेबसाइट से रियल-टाइम डेटा',
    stats_no_links: 'अभी कोई लिंक नहीं। लिंक कन्वर्ट करके शुरू करें।',
    stats_your_links: 'आपके आखिरी 10 लिंक',
    stats_tap_copy: 'लिंक पर टैप करें → कॉपी → शेयर करें',
    stats_your_views: 'आपके व्यूज़',
    stats_your_income: 'आपकी कमाई',
    stats_your_tier: 'आपका टियर',
    stats_withdraw: 'पैसे निकालें',
    stats_withdraw_info: 'कम से कम $20 · बैंक/UPI',
    stats_processing: 'प्रोसेसिंग',
    stats_processing_info: '24–48 घंटे',
    earnings_title: 'मायाजाल कमाई मॉडल',
    earnings_base: 'बेस रेट',
    earnings_bonus: 'बोनस',
    earnings_bonus_text: 'हर अतिरिक्त 2,000 व्यूज़ → रेट × 1.5 (50% बूस्ट)',
    earnings_tier_table: 'टियर टेबल',
    earnings_example: 'उदाहरण (5K व्यूज़)',
    earnings_example_total: 'कुल',
    your_stats_title: 'आपके स्टैट्स',
    connect_required: 'स्टैट्स देखने के लिए पहले API कनेक्ट करें',
    open_website: 'वेबसाइट खोलें',
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

// ===== FIRESTORE HELPERS =====
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
      api_key: data.api_key || '',
      is_logged_in: data.is_logged_in !== undefined ? data.is_logged_in : false,
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

// ===== FIRESTORE LINK HELPERS =====
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

// ===== REALTIME DB HELPERS (Website Sync) =====
async function findUserByApiKeyRTDB(key) {
  if (!firebaseReady) return null;
  try {
    const snap = await getRTDB().ref('users').orderByChild('apiKey').equalTo(key).once('value');
    if (!snap.exists()) return null;
    const val = snap.val();
    const firebaseUid = Object.keys(val)[0];
    return { uid: firebaseUid, ...val[firebaseUid] };
  } catch (e) {
    console.error('[RTDB FindByApiKey]', e.message);
    return null;
  }
}

async function findUserByTelegram(tgId) {
  if (!firebaseReady) return null;
  try {
    const snap = await getRTDB().ref('users').orderByChild('telegram/chatId').equalTo(Number(tgId)).limitToFirst(1).once('value');
    if (!snap.exists()) return null;
    const val = snap.val();
    const uid = Object.keys(val)[0];
    return { uid, ...val[uid] };
  } catch (e) {
    console.error('[RTDB FindByTelegram]', e.message);
    return null;
  }
}

async function getDashboard(firebaseUid) {
  if (!firebaseReady) return {};
  try {
    const snap = await getRTDB().ref(`users/${firebaseUid}/dashboard`).once('value');
    return snap.val() || {};
  } catch (e) {
    console.error('[getDashboard]', e.message);
    return {};
  }
}

async function getUserLinks(firebaseUid, limit = 10) {
  if (!firebaseReady) return [];
  try {
    const snap = await getRTDB().ref('links').orderByChild('ownerUid').equalTo(firebaseUid).once('value');
    if (!snap.exists()) return [];
    const val = snap.val();
    const arr = Object.keys(val).map(k => ({ id: k, ...val[k] }));
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return arr.slice(0, limit);
  } catch (e) {
    console.error('[getUserLinks]', e.message);
    return [];
  }
}

async function incrementDashboard(firebaseUid, field, byVal = 1) {
  if (!firebaseReady) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const ref = getRTDB().ref(`users/${firebaseUid}/dashboard`);
    await ref.transaction((d) => {
      d = d || {};
      if (field === 'totalLinks') {
        d.totalLinks = (d.totalLinks || 0) + byVal;
        d.linksByDay = d.linksByDay || {};
        d.linksByDay[today] = (d.linksByDay[today] || 0) + byVal;
      }
      return d;
    });
  } catch (e) {
    console.error('[incrementDashboard]', e.message);
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

// ===== SHORTEN URL (Firestore + RTDB sync) =====
// ⭐ CHANGED: short link now uses /s/ prefix
async function shortenUrl(longUrl, ownerId) {
  const slug = crypto.randomBytes(5).toString('hex');
  const sig = signSlug(slug);
  const combined = slug + sig;

  // 1. Save to Firestore
  await saveLink(slug, { url: longUrl, owner_id: String(ownerId), views: 0, created: Date.now() });
  console.log(`[Shorten] ${slug} → user ${ownerId}`);

  // 2. Save to Realtime DB (for website dashboard sync)
  try {
    const fbUser = await findUserByTelegram(ownerId);
    if (fbUser) {
      await getRTDB().ref(`links/${slug}`).set({
        ownerUid: fbUser.uid,
        originalUrl: longUrl,
        shortCode: combined,
        views: 0,
        createdAt: Date.now(),
        source: 'converter',
      });
      await incrementDashboard(fbUser.uid, 'totalLinks', 1);
      console.log(`[RTDB] Link ${slug} synced for ${fbUser.email}`);
    }
  } catch (e) {
    console.error('[RTDB shorten]', e.message);
  }

  // ⭐ /s/ prefix added
  return { slug, sig, combined, short: `https://${SHORT_DOMAIN}/s/${combined}` };
}
// ===== LANDING PAGE =====
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

app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  firebase: firebaseReady,
  rtdb: !!rtdb,
}));

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

// ===== API: Shorten endpoint (external use) =====
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

// ============================================================
// ⭐ CHANGED: Short link route now uses /s/:combined prefix
// Full URL: https://www.mayajaal.online/s/a1b2c3d4e5f6g7h8
// ============================================================
app.get('/s/:combined', async (req, res) => {
  const combined = req.params.combined;

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

  // 1. Update Firestore link views
  await updateLink(realSlug, { views: (link.views || 0) + 1 });

  // 2. Update Firestore user balance + clicks
  const user = await getUser(link.owner_id);
  if (user) {
    await updateUser(user.id, {
      balance: parseFloat(user.balance || 0) + 0.05,
      clicks: (user.clicks || 0) + 1,
    });
  }

  // 3. Update Realtime DB — link views + user dashboard (website sync)
  try {
    const today = new Date().toISOString().split('T')[0];

    // 3a. Increment RTDB link views
    await getRTDB().ref(`links/${realSlug}/views`).transaction(v => (v || 0) + 1);

    // 3b. Increment RTDB user dashboard — only if user is linked
    const rtdbUser = await getRTDB().ref(`links/${realSlug}/ownerUid`).once('value');
    const ownerUid = rtdbUser.val();
    if (ownerUid) {
      await getRTDB().ref(`users/${ownerUid}/dashboard`).transaction(d => {
        d = d || {};
        d.totalViews = (d.totalViews || 0) + 1;
        d.todayViews = (d.todayViews || 0) + 1;
        d.viewsByDay = d.viewsByDay || {};
        d.viewsByDay[today] = (d.viewsByDay[today] || 0) + 1;
        return d;
      });
      console.log(`[VIEW-RTDB] +1 for ${realSlug} owner=${ownerUid}`);
    }
  } catch (e) {
    console.error('[RTDB view]', e.message);
  }

  // 4. Extract video ID if link points to /v/xxx
  let videoId = '';
  try {
    const m = link.url.match(/\/v\/([a-f0-9]+)/i);
    if (m) videoId = m[1];
  } catch (e) {}

  return res.send(landingPageHTML(combined, link.url, videoId));
});

// ============================================================
// Fallback: bare /:combined route (backward compatibility)
// Ye purane links ko handle karega jo /s/ ke bina bane the
// ============================================================
app.get('/:combined', async (req, res) => {
  const combined = req.params.combined;

  if (combined === 'health' || combined === 'favicon.ico' || combined.startsWith('.')) {
    return res.status(404).end();
  }
  if (combined.length !== 16) return res.status(404).send('Not found');

  // Redirect to /s/ version
  return res.redirect(301, `/s/${combined}`);
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
        new Api.BotCommand({ command: 'stats', description: '📊 My Stats' }),
        new Api.BotCommand({ command: 'mylinks', description: '🔗 My Links' }),
        new Api.BotCommand({ command: 'earnings', description: '💰 Earnings Model' }),
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

  // ===== SAFE USER FETCHER =====
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
    const userData = await getUserKeySynced(uid);
    const statusText = userData ? `✅ API Connected` : `⚠️ Not Connected`;

    const text = t(lang, 'welcome') + '\n\n━━━━━━━━━━━━━━━━━━━━━━\n' + statusText;
    const rows = [
      [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }, { text: `🔗 ${t(lang, 'btn_mylinks')}`, callback_data: 'menu_mylinks' }],
      [{ text: `💰 ${t(lang, 'btn_earnings')}`, callback_data: 'menu_earnings' }, { text: `🔌 ${t(lang, 'api')}`, callback_data: 'menu_api' }],
      [{ text: t(lang, 'convert'), callback_data: 'menu_convert' }, { text: t(lang, 'bulk'), callback_data: 'menu_bulk' }],
      [{ text: `📖 ${t(lang, 'btn_help')}`, callback_data: 'menu_help' }, { text: t(lang, 'allbots'), callback_data: 'menu_allbots' }],
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

  // ===== HELP MENU =====
  async function sendHelp(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text =
      `📖 <b>${lang === 'hi' ? 'मदद और गाइड' : 'Help & Guide'}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>${lang === 'hi' ? 'स्टेप 1' : 'Step 1'} — API Connect:</b>\n` +
      `├ /start → ${t(lang, 'api')}\n` +
      `├ ${lang === 'hi' ? 'वेबसाइट से key कॉपी करें' : 'Copy key from website'}\n` +
      `└ <code>/api YOUR_KEY</code>\n\n` +
      `<b>${lang === 'hi' ? 'स्टेप 2' : 'Step 2'} — Convert Link:</b>\n` +
      `├ ${lang === 'hi' ? 'कोई भी link भेजें' : 'Send any link'}\n` +
      `└ ${lang === 'hi' ? 'शॉर्ट लिंक मिलेगा' : 'Get short link'}\n\n` +
      `<b>${lang === 'hi' ? 'स्टेप 3' : 'Step 3'} — Bulk Convert:</b>\n` +
      `├ ${lang === 'hi' ? '1000+ links भेजें (हर लाइन में एक)' : 'Send 1000+ links (one per line)'}\n` +
      `└ ${lang === 'hi' ? 'सब convert हो जाएंगे' : 'All get converted'}\n\n` +
      `<b>${lang === 'hi' ? 'स्टेप 4' : 'Step 4'} — Earn & Share:</b>\n` +
      `├ ${lang === 'hi' ? 'शॉर्ट लिंक WhatsApp/Insta पर शेयर करें' : 'Share short links on WhatsApp/Insta'}\n` +
      `└ ${lang === 'hi' ? 'हर view पर कमाई' : 'Earn on every view'}\n\n` +
      `<i>💡 ${lang === 'hi' ? 'कमाई वेबसाइट dashboard पर LIVE दिखती है' : 'Earnings show LIVE on website dashboard'}</i>`;

    const rows = [[{ text: t(lang, 'back'), callback_data: 'main_menu' }]];
    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== ALL BOTS =====
  async function sendAllBots(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text =
      `🤖 <b>${lang === 'hi' ? 'सभी MayaJaal बॉट्स' : 'All MayaJaal Bots'}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>1. 🔗 Link Converter Bot</b>\n` +
      `<i>${lang === 'hi' ? 'शॉर्ट लिंक बनाएं + कमाई' : 'Short links + earning'}</i>\n` +
      `Status: ✅ ${lang === 'hi' ? 'सक्रिय' : 'Active'}\n\n` +
      `<b>2. 🎬 Stream Bot</b>\n` +
      `<i>${lang === 'hi' ? 'वीडियो अपलोड + प्लेयर लिंक' : 'Video upload + player link'}</i>\n` +
      `Status: ✅ ${lang === 'hi' ? 'सक्रिय' : 'Active'}\n\n` +
      `<i>🔒 ${lang === 'hi' ? 'सबका डेटा सुरक्षित है' : "Everyone's data is safe"}</i>`;

    const rows = [[{ text: t(lang, 'back'), callback_data: 'main_menu' }]];
    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== SETTINGS =====
  async function sendSettings(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text =
      `${t(lang, 'settings_title')}\n\n` +
      `<b>${t(lang, 'current_language')}:</b> ${lang === 'hi' ? 'हिंदी' : 'English'}`;

    const rows = [
      [{ text: t(lang, 'language'), callback_data: 'menu_language' }],
      [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
    ];
    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== LANGUAGE SELECTOR =====
  async function sendLanguageSelector(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const text = t(lang, 'choose_language') + `\n\n${t(lang, 'current_language')}: <b>${lang === 'hi' ? 'हिंदी' : 'English'}</b>`;
    const rows = [
      [{ text: '🇬🇧 English', callback_data: 'set_lang_en' }],
      [{ text: '🇮🇳 हिंदी', callback_data: 'set_lang_hi' }],
      [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
    ];
    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== STATS (Dashboard from RTDB — same data as website) =====
  async function sendStats(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const fbUser = await findUserByTelegram(uid);

    if (!fbUser) {
      const msgText =
        `🔒 <b>${t(lang, 'connect_required')}</b>\n\n` +
        `<b>${lang === 'hi' ? 'स्टेप' : 'Steps'}:</b>\n` +
        `1. /start → ${t(lang, 'api')}\n` +
        `2. ${lang === 'hi' ? 'वेबसाइट से key कॉपी करें' : 'Copy key from website'}\n` +
        `3. <code>/api YOUR_KEY</code>`;
      const btns = keyboard([
        [{ text: `🔌 ${t(lang, 'api')}`, url: `${BASE_URL}/?tg=${uid}` }],
        [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
      ]);
      if (editMsgId) {
        try { await client.editMessage(chatId, { message: editMsgId, text: msgText, parseMode: 'html', buttons: btns }); return; } catch (e) {}
      }
      await client.sendMessage(chatId, { message: msgText, parseMode: 'html', buttons: btns });
      return;
    }

    const dash = await getDashboard(fbUser.uid);
    const views = dash.totalViews || 0;
    const income = calcEarnings(views);
    const tier = getTierInfo(views);

    const text =
      `<b>📊 ${t(lang, 'stats_title')}</b>\n` +
      `<b>━━━━━━━━━━━━━━━━━━━━━━</b>\n\n` +
      `👤 <b>${t(lang, 'stats_email')}:</b> ${fbUser.email || 'N/A'}\n` +
      `🔗 <b>${t(lang, 'stats_links')}:</b> <b>${dash.totalLinks || 0}</b>\n` +
      `👁 <b>${t(lang, 'stats_views')}:</b> <b>${views}</b>\n` +
      `📅 <b>${t(lang, 'stats_today')}:</b> <b>${dash.todayViews || 0}</b>\n\n` +
      `<b>💰 ${t(lang, 'btn_earnings').toUpperCase()}</b>\n` +
      `├ <b>${t(lang, 'stats_income')}:</b> $<b>${income.toFixed(2)}</b>\n` +
      `├ <b>${t(lang, 'stats_rate')}:</b> $${tier.rate.toFixed(2)}/1K\n` +
      `├ <b>${t(lang, 'stats_tier')}:</b> TIER ${tier.tier}\n` +
      `└ <b>${t(lang, 'stats_next_boost')}:</b> ${tier.next} views\n\n` +
      `<b>🏆 ${t(lang, 'stats_base')}:</b> 1K = $1\n` +
      `<b>🎁 ${t(lang, 'stats_bonus')}:</b> ${t(lang, 'earnings_bonus_text')}\n\n` +
      `<i>💡 ${t(lang, 'stats_synced')}</i>`;

    const rows = [
      [{ text: `🔗 ${t(lang, 'btn_mylinks')}`, callback_data: 'menu_mylinks' }, { text: `💰 ${t(lang, 'btn_earnings')}`, callback_data: 'menu_earnings' }],
      [{ text: `🌐 ${t(lang, 'open_website')}`, url: `${BASE_URL}/` }],
      [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== MY LINKS (Last 10 converted links with views + per-link earnings) =====
  async function sendMyLinks(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const fbUser = await findUserByTelegram(uid);

    if (!fbUser) {
      const msgText = `🔒 <b>${t(lang, 'connect_required')}</b>`;
      const btns = keyboard([
        [{ text: `🔌 ${t(lang, 'api')}`, url: `${BASE_URL}/?tg=${uid}` }],
        [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
      ]);
      if (editMsgId) {
        try { await client.editMessage(chatId, { message: editMsgId, text: msgText, parseMode: 'html', buttons: btns }); return; } catch (e) {}
      }
      await client.sendMessage(chatId, { message: msgText, parseMode: 'html', buttons: btns });
      return;
    }

    const links = await getUserLinks(fbUser.uid, 10);
    let linksText = `<b>🔗 ${t(lang, 'stats_your_links')}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (!links.length) {
      linksText += `<i>${t(lang, 'stats_no_links')}</i>`;
    } else {
      links.forEach((l, i) => {
        const name = (l.originalUrl || l.filename || 'link').substring(0, 30);
        const v = l.views || 0;
        const e = calcEarnings(v);
        linksText += `<b>${i + 1}.</b> ${escapeHtml(name)}\n`;
        linksText += `    👁 ${v} views · 💰 $${e.toFixed(2)}\n`;
        if (l.shortCode) linksText += `    <code>https://${SHORT_DOMAIN}/s/${l.shortCode}</code>\n\n`;
        else linksText += `    <code>${BASE_URL}/s/${l.id}</code>\n\n`;
      });
    }
    linksText += `<i>💡 ${t(lang, 'stats_tap_copy')}</i>`;

    const rows = [
      [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
      [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text: linksText, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: linksText, parseMode: 'html', buttons: keyboard(rows) });
  }

  // ===== EARNINGS MODEL (Tier table with current tier highlighted) =====
  async function sendEarnings(chatId, uid, editMsgId = null) {
    const lang = await getUserLang(uid);
    const fbUser = await findUserByTelegram(uid);
    let views = 0, currentTier = 1;
    if (fbUser) {
      const dash = await getDashboard(fbUser.uid);
      views = dash.totalViews || 0;
      currentTier = getTierInfo(views).tier;
    }
    const income = calcEarnings(views);

    const mark = (tier) => currentTier === tier ? '▶️' : '  ';
    const tierText =
      `<b>💰 ${t(lang, 'earnings_title')}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>📌 ${t(lang, 'earnings_base')}:</b> 1,000 views = <b>$1.00</b>\n` +
      `<b>🎁 ${t(lang, 'earnings_bonus')}:</b> ${t(lang, 'earnings_bonus_text')}\n\n` +
      `<b>📊 ${t(lang, 'earnings_tier_table')}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${mark(1)} <b>TIER 1</b>   0–1K      $1.00/1K\n` +
      `${mark(2)} <b>TIER 2</b>   1K–3K     $1.50/1K\n` +
      `${mark(3)} <b>TIER 3</b>   3K–5K     $2.25/1K\n` +
      `${mark(4)} <b>TIER 4</b>   5K–7K     $3.38/1K\n` +
      `${mark(5)} <b>TIER 5</b>   7K–9K     $5.06/1K\n` +
      `${mark(6)} <b>TIER 6</b>   9K–11K    $7.59/1K\n\n` +
      `<b>🧮 ${t(lang, 'earnings_example')}:</b>\n` +
      `1K × $1.00 = $1.00\n` +
      `2K × $1.50 = $3.00\n` +
      `2K × $2.25 = $4.50\n` +
      `<b>${t(lang, 'earnings_example_total')} = $8.50</b>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      (fbUser ?
        `👁 <b>${t(lang, 'stats_your_views')}:</b> ${views}\n` +
        `💰 <b>${t(lang, 'stats_your_income')}:</b> $${income.toFixed(2)}\n` +
        `🏆 <b>${t(lang, 'stats_your_tier')}:</b> TIER ${currentTier}\n\n` : '') +
      `💵 <b>${t(lang, 'stats_withdraw')}:</b> ${t(lang, 'stats_withdraw_info')}\n` +
      `⏱ <b>${t(lang, 'stats_processing')}:</b> ${t(lang, 'stats_processing_info')}`;

    const rows = [
      [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
      [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text: tierText, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: tierText, parseMode: 'html', buttons: keyboard(rows) });
  }
  // ============================================================
// MESSAGE HANDLER — Commands (/start, /api, /stats, /mylinks, /earnings, /logout, /help)
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

    // /stats
    if (text === '/stats') {
      await getOrCreateUser(uid, msg);
      await sendStats(chatId, uid);
      return;
    }

    // /mylinks
    if (text === '/mylinks') {
      await getOrCreateUser(uid, msg);
      await sendMyLinks(chatId, uid);
      return;
    }

    // /earnings
    if (text === '/earnings') {
      await getOrCreateUser(uid, msg);
      await sendEarnings(chatId, uid);
      return;
    }

    // /api (bina key) — help message
    if (text === '/api') {
      await client.sendMessage(chatId, {
        message: `🔑 <b>Connect API Key</b>\n\n` +
          `<b>Format:</b> <code>/api YOUR_KEY</code>\n\n` +
          `<b>Example:</b>\n<code>/api abc123def456</code>\n\n` +
          `📌 <b>Key kahan se milegi?</b>\n` +
          `Menu → <b>🔌 API Connect</b> → key copy karo\n` +
          `Ya website: ${BASE_URL}`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🔌 API Connect', url: `${BASE_URL}/?tg=${uid}` }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // /api <KEY> — connect via RTDB
    if (text.startsWith('/api ')) {
      const key = text.replace('/api ', '').trim();
      if (key.length < 12) {
        await client.sendMessage(chatId, { message: t(lang, 'invalid_key'), parseMode: 'html' });
        return;
      }

      // RTDB me query — website ne yahan key save ki hai
      const fbUser = await findUserByApiKeyRTDB(key);
      if (!fbUser) {
        await client.sendMessage(chatId, {
          message: t(lang, 'api_key_not_found'),
          parseMode: 'html',
          buttons: keyboard([
            [{ text: '🌐 Open Website', url: `${BASE_URL}/?tg=${uid}` }],
          ]),
        });
        return;
      }

      // RTDB me Telegram link karo
      try {
        await getRTDB().ref(`users/${fbUser.uid}/telegram`).update({
          chatId: Number(uid),
          tgName: msg.sender?.firstName || 'user',
          linkedAt: Date.now(),
        });
      } catch (e) {
        console.error('[RTDB link telegram]', e.message);
      }

      // Firestore me bhi save (cross-bot session)
      await getOrCreateUser(uid, msg);
      await updateUser(uid, { api_key: key, is_logged_in: true });
      await redisSaveUserKey(uid, key);

      await client.sendMessage(chatId, {
        message: `✅ <b>${t(lang, 'api_connected')}</b>\n\n` +
          `👤 <b>${t(lang, 'stats_email')}:</b> ${fbUser.email || 'N/A'}\n` +
          `🔑 <b>Key:</b> <code>${escapeHtml(key.substring(0, 8))}...</code>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
          [{ text: t(lang, 'convert'), callback_data: 'menu_convert' }],
        ]),
      });
      return;
    }

    // /logout
    if (text === '/logout') {
      await updateUser(uid, { api_key: '', is_logged_in: false });
      await redisDeleteUserKey(uid);
      await client.sendMessage(chatId, { message: t(lang, 'logout_success'), parseMode: 'html' });
      return;
    }

    // /help or /menu
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
// MESSAGE HANDLER — URL Conversion (single + bulk)
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

    // Session check (cross-bot) — kya user API connect hai?
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

    // ===== SINGLE URL =====
    if (urls.length === 1) {
      const status = await client.sendMessage(chatId, { message: t(lang, 'converting'), parseMode: 'html' });
      try {
        const result = await shortenUrl(urls[0], uid);
        await updateUser(uid, { links_count: (user.links_count || 0) + 1 });

        // ---- Stats line for reply ----
        let statsLine = '';
        const fbUser = await findUserByTelegram(uid);
        if (fbUser) {
          const dash = await getDashboard(fbUser.uid);
          const totalV = dash.totalViews || 0;
          const inc = calcEarnings(totalV);
          statsLine = `\n\n📊 <b>${t(lang, 'your_stats_title')}</b>\n` +
            `├ 🔗 ${t(lang, 'stats_links')}: <b>${dash.totalLinks || 0}</b>\n` +
            `├ 👁 ${t(lang, 'stats_views')}: <b>${totalV}</b>\n` +
            `└ 💰 ${t(lang, 'stats_income')}: <b>$${inc.toFixed(2)}</b>`;
        }

        const report =
          t(lang, 'link_converted') + `\n\n` +
          `<b>${t(lang, 'original')}:</b>\n${escapeHtml(urls[0])}\n\n` +
          `<b>${t(lang, 'smart_link')}:</b>\n${result.short}` +
          statsLine;

        const rows = [
          [{ text: '🔗 Open Link', url: result.short }],
          [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }, { text: `🔗 ${t(lang, 'btn_mylinks')}`, callback_data: 'menu_mylinks' }],
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

    // ===== BULK URLs =====
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

        // Progress update every batch
        try {
          const done = Math.min(i + CONCURRENCY, urls.length);
          await client.editMessage(chatId, {
            message: status.id,
            text: `⏳ <b>Processing ${done} / ${urls.length}...</b>`,
            parseMode: 'html',
          });
        } catch (e) {}
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
        buttons: keyboard([
          [{ text: `🔗 ${t(lang, 'btn_mylinks')}`, callback_data: 'menu_mylinks' }],
          [{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }],
        ]),
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
  // CALLBACK HANDLER — All button clicks
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

    // ---- Stats (RTDB live dashboard) ----
    if (data === 'menu_stats') {
      await sendStats(chatId, uid, msgId);
      return;
    }

    // ---- My Links ----
    if (data === 'menu_mylinks') {
      await sendMyLinks(chatId, uid, msgId);
      return;
    }

    // ---- Earnings Model ----
    if (data === 'menu_earnings') {
      await sendEarnings(chatId, uid, msgId);
      return;
    }

    // ---- Help ----
    if (data === 'menu_help') {
      await sendHelp(chatId, uid, msgId);
      return;
    }

    // ---- Income (Firestore balance + RTDB live) ----
    if (data === 'menu_income') {
      const balance = parseFloat(user?.balance || 0).toFixed(2);
      const clicks = user?.clicks || 0;
      const linksCount = user?.links_count || 0;

      // Also show RTDB dashboard if available
      let rtdbLine = '';
      try {
        const fbUser = await findUserByTelegram(uid);
        if (fbUser) {
          const dash = await getDashboard(fbUser.uid);
          const views = dash.totalViews || 0;
          const inc = calcEarnings(views);
          rtdbLine =
            `\n\n<b>📊 LIVE ${t(lang, 'stats_title')}</b>\n` +
            `├ 👁 ${t(lang, 'stats_views')}: <b>${views}</b>\n` +
            `├ 📅 ${t(lang, 'stats_today')}: <b>${dash.todayViews || 0}</b>\n` +
            `└ 💰 ${t(lang, 'stats_income')}: <b>$${inc.toFixed(2)}</b>`;
        }
      } catch (e) {}

      const text =
        `📊 <b>${t(lang, 'your_income')}</b>\n\n` +
        `💰 <b>${t(lang, 'earnings')}:</b> ₹${balance}\n` +
        `👀 <b>${t(lang, 'clicks')}:</b> ${clicks}\n` +
        `🔗 <b>${t(lang, 'links')}:</b> ${linksCount}` +
        rtdbLine;

      await client.editMessage(chatId, {
        message: msgId,
        text: text,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
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
      await sendAllBots(chatId, uid, msgId);
      return;
    }

    // ---- API Connect ----
    if (data === 'menu_api') {
      const fbUser = await findUserByTelegram(uid);
      const rtdbKey = fbUser?.apiKey || null;
      const firestoreKey = user?.api_key || null;
      const activeKey = rtdbKey || firestoreKey;

      if (activeKey) {
        await client.editMessage(chatId, {
          message: msgId,
          text:
            `🔌 <b>${t(lang, 'api_connect')}</b>\n\n` +
            `✅ <b>${t(lang, 'your_api_key')}:</b>\n` +
            `<code>${escapeHtml(activeKey.substring(0, 8))}...${escapeHtml(activeKey.slice(-4))}</code>\n\n` +
            (fbUser?.email ? `👤 <b>${t(lang, 'stats_email')}:</b> ${fbUser.email}\n\n` : '') +
            `<i>${t(lang, 'api_note')}</i>`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: '🌐 Open Website', url: `${BASE_URL}/?tg=${uid}` }],
            [{ text: `🔄 ${t(lang, 'reset_api')}`, callback_data: 'reset_api' }],
            [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
          ]),
        });
      } else {
        await client.editMessage(chatId, {
          message: msgId,
          text:
            `🔌 <b>${t(lang, 'api_connect')}</b>\n\n` +
            `<b>${lang === 'hi' ? 'स्टेप' : 'Steps'}:</b>\n` +
            `1. ${lang === 'hi' ? 'वेबसाइट खोलें' : 'Open website'}\n` +
            `2. Google se login karo\n` +
            `3. API key copy karo\n` +
            `4. <code>/api YOUR_KEY</code> bhejo\n\n` +
            `<i>${t(lang, 'api_note')}</i>`,
          parseMode: 'html',
          buttons: keyboard([
            [{ text: '🔑 Generate Key', url: `${BASE_URL}/?tg=${uid}` }],
            [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
          ]),
        });
      }
      return;
    }

    // ---- Account ----
    if (data === 'menu_account') {
      const fbUser = await findUserByTelegram(uid);
      const isConnected = !!(fbUser || user?.is_logged_in);
      await client.editMessage(chatId, {
        message: msgId,
        text:
          `${t(lang, 'account_info')}\n\n` +
          `<b>${t(lang, 'username')}:</b> @${escapeHtml(user?.username || 'user')}\n` +
          `<b>${t(lang, 'user_id')}:</b> <code>${uid}</code>\n` +
          `<b>API:</b> ${isConnected ? '✅ Connected' : '❌ Not Connected'}\n` +
          (fbUser?.email ? `<b>${t(lang, 'stats_email')}:</b> ${fbUser.email}\n` : '') +
          `<b>${t(lang, 'links')}:</b> ${user?.links_count || 0}\n` +
          `<b>${t(lang, 'clicks')}:</b> ${user?.clicks || 0}`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Settings ----
    if (data === 'menu_settings') {
      await sendSettings(chatId, uid, msgId);
      return;
    }

    // ---- Language selector ----
    if (data === 'menu_language') {
      await sendLanguageSelector(chatId, uid, msgId);
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
      // Also unlink from RTDB
      try {
        const fbUser = await findUserByTelegram(uid);
        if (fbUser) {
          await getRTDB().ref(`users/${fbUser.uid}/telegram`).remove();
        }
      } catch (e) {}
      await client.editMessage(chatId, {
        message: msgId,
        text: t(lang, 'logout_success'),
        parseMode: 'html',
        buttons: keyboard([[{ text: t(lang, 'main_menu'), callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ---- Reset API (generate new key, sync both DBs) ----
    if (data === 'reset_api') {
      const newKey = crypto.randomBytes(16).toString('hex').toUpperCase();

      // Save to Firestore
      await updateUser(uid, { api_key: newKey, is_logged_in: true });

      // Save to Redis
      await redisSaveUserKey(uid, newKey);

      // Also update RTDB if user exists there
      try {
        const fbUser = await findUserByTelegram(uid);
        if (fbUser) {
          await getRTDB().ref(`users/${fbUser.uid}/apiKey`).set(newKey);
        }
      } catch (e) {}

      await client.editMessage(chatId, {
        message: msgId,
        text:
          `✅ <b>API Reset!</b>\n\n` +
          `<b>New Key:</b>\n<code>${newKey}</code>\n\n` +
          `<i>${t(lang, 'api_note')}</i>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: `📊 ${t(lang, 'btn_stats')}`, callback_data: 'menu_stats' }],
          [{ text: t(lang, 'back'), callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ---- Main menu ----
    if (data === 'main_menu') {
      await sendMenu(chatId, uid, msgId);
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready — MayaJaal Converter v2.4.0 (www.mayajaal.online/s/ + RTDB Sync + Stats)');
})();

// ============ END OF FILE ============
