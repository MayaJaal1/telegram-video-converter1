require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const axios = require('axios');
const crypto = require('crypto');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const SHORT_DOMAIN = (process.env.SHORT_DOMAIN || 'm.mayajaal.online').trim();
const BASE_URL = (process.env.BASE_URL || 'https://mayajaal.online').trim();
const PORT = parseInt(process.env.PORT || '8090', 10);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').trim();
const LINK_SECRET = (process.env.LINK_SECRET || 'CHANGE-THIS-NOW-TO-RANDOM-32-CHARS').trim();

// ===== APP LINK CONFIG =====
const APP_NAME = process.env.APP_NAME || 'MayaJaal';
const APP_SCHEME = process.env.APP_SCHEME || 'mayajaal';
const APP_PACKAGE = process.env.APP_PACKAGE || 'com.mayajaal.app';
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${APP_PACKAGE}`;
const APP_STORE_URL = process.env.APP_STORE_URL || 'https://apps.apple.com/app/mayajaal/id000000000';

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
console.log('SUPABASE:', !!SUPABASE_URL, !!SUPABASE_KEY);
console.log('LINK_SECRET:', LINK_SECRET.length >= 20 ? 'OK' : 'WEAK!');
console.log('APP:', APP_NAME, '| Package:', APP_PACKAGE);

if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing credentials');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing Supabase config');
if (LINK_SECRET.length < 20) throw new Error('LINK_SECRET too weak');

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
}// ===== SMART LANDING PAGE HTML =====
function landingPageHTML(combined, targetUrl, videoId) {
  const androidIntent = `intent://watch?v=${videoId}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
  const iosScheme = `${APP_SCHEME}://watch?v=${videoId}`;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${APP_NAME} - Opening...</title>
<meta property="og:title" content="${APP_NAME} Video">
<meta property="og:description" content="Watch on ${APP_NAME} app">
<meta property="og:type" content="video.other">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}
.logo{font-size:48px;font-weight:800;background:linear-gradient(135deg,#00ff88,#00b4ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px}
.spinner{width:64px;height:64px;border:4px solid #1a1a1a;border-top-color:#00ff88;border-radius:50%;animation:spin 1s linear infinite;margin:32px auto}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:16px;color:#888;margin:16px 0}
.btn{display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#00ff88,#00b4ff);color:#000;text-decoration:none;border-radius:10px;font-weight:700;margin:8px;font-size:15px}
.btn-secondary{background:#1a1a1a;color:#fff;border:1px solid #333}
.store-badges{display:flex;gap:12px;justify-content:center;margin-top:20px;flex-wrap:wrap}
.store-btn{padding:10px 20px;background:#1a1a1a;border-radius:8px;color:#fff;text-decoration:none;font-size:13px;border:1px solid #2a2a2a}
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
  var isMobile = isAndroid || isIOS;
  var appOpened = false;

  // Detect if app opened (page becomes hidden)
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) appOpened = true;
  });
  window.addEventListener('blur', function() { appOpened = true; });

  function showFallback() {
    if (appOpened) return;
    document.getElementById('msg').innerHTML = 'App not installed?<br><small style="color:#666">Download to watch faster</small>';
    document.getElementById('actions').style.display = 'block';
  }

  if (isAndroid) {
    // Android: Use intent:// URL - auto-redirects to Play Store if app missing
    window.location.href = '${androidIntent}';
    setTimeout(showFallback, 2500);
  } else if (isIOS) {
    // iOS: Try custom scheme, fallback to App Store
    window.location.href = '${iosScheme}';
    setTimeout(function() {
      if (!appOpened) window.location.href = '${APP_STORE_URL}';
      setTimeout(showFallback, 2000);
    }, 2000);
  } else {
    // Desktop - just show options
    document.getElementById('msg').innerHTML = 'Open this link on mobile to use the app';
    document.getElementById('actions').style.display = 'block';
  }
})();
</script>
</body>
</html>`;
}

// ===== EXPRESS =====
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ===== APP VERIFICATION FILES =====
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
      details: [{
        appID: (process.env.APPLE_TEAM_ID || 'TEAMID') + '.' + APP_PACKAGE,
        paths: ['*'],
      }],
    },
  }, null, 2));
});

// ===== API =====
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
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== SMART LANDING PAGE =====
app.get('/:combined', async (req, res) => {
  const combined = req.params.combined;
  if (combined === 'health') return res.json({ ok: true });

  if (combined.length !== 16) {
    return res.status(403).send('Invalid link');
  }

  const realSlug = combined.substring(0, 10);
  const providedSig = combined.substring(10, 16);
  const expectedSig = signSlug(realSlug);

  if (providedSig !== expectedSig) {
    return res.status(403).send('Invalid or tampered link');
  }

  const link = await getLink(realSlug);
  if (!link) return res.status(404).send('Link not found');

  // Track view
  await sbPatch('links', `?slug=eq.${encodeURIComponent(realSlug)}`, { views: (link.views || 0) + 1 });
  const user = await getUser(link.owner_id);
  if (user) {
    await sbPatch('users', `?id=eq.${encodeURIComponent(user.id)}`, {
      balance: parseFloat(user.balance || 0) + 0.05,
      clicks: (user.clicks || 0) + 1,
    });
  }

  // Extract video ID from URL (if it's a mayajaal player link)
  let videoId = '';
  try {
    const m = link.url.match(/\/v\/([a-f0-9]+)/i);
    if (m) videoId = m[1];
  } catch (e) {}

  // Serve smart landing page
  return res.send(landingPageHTML(combined, link.url, videoId));
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));

// ===== BOT =====
(async () => {
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

  async function sendMenu(chatId, editMsgId = null) {
    const text = `👋 <b>Welcome to MayaJaal.online</b>\n` +
      `<i>Link Shortener • Convert • Earn</i>\n` +
      `<b>Fast, Secure & Reliable</b>\n\n` +
      `✅ MayaJaal.online ke links convert karo\n` +
      `✅ Bulk link converter (1000+ links ek saath)\n` +
      `✅ Super fast conversion\n` +
      `✅ Har link ka detailed report\n` +
      `📱 <b>App me direct khulta hai</b>\n` +
      `🛡️ <b>Sabka data safe hai</b>\n\n` +
      `Start karne ke liye neeche diye gaye menu se option select kare ya /start likhe.`;
    const rows = [
      [{ text: '🔗 Convert Link', callback_data: 'menu_convert' }, { text: '🗂 Bulk Converter', callback_data: 'menu_bulk' }],
      [{ text: '💰 Income', callback_data: 'menu_income' }, { text: '📊 View Transfer', callback_data: 'menu_transfer' }],
      [{ text: '🤖 All Bots', callback_data: 'menu_allbots' }, { text: '🔌 API Connect', callback_data: 'menu_api' }],
      [{ text: '👤 Account', callback_data: 'menu_account' }, { text: '🚪 Logout', callback_data: 'menu_logout' }],
    ];
    if (editMsgId) {
      try {
        await client.editMessage(chatId, { message: editMsgId, text, parseMode: 'html', buttons: keyboard(rows) });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: keyboard(rows) });
  }

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    if ((msg.message || '') === '/start') {
      const uid = getSenderId(msg);
      let user = await getUser(uid);
      if (!user) {
        const sender = await msg.getSender();
        user = await createUser(uid, sender?.username || sender?.firstName || 'user');
      }
      await sendMenu(msg.chatId);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const chatId = msg.chatId;
    const text = msg.message || '';
    if (!text || text.startsWith('/')) return;

    const uid = getSenderId(msg);
    let user = await getUser(uid);
    if (!user) {
      const sender = await msg.getSender();
      user = await createUser(uid, sender?.username || 'user');
    }

    if (!checkRateLimit(uid, 60)) {
      return client.sendMessage(chatId, { message: `⚠️ <b>Rate limit exceeded</b>\n\n1 minute me 60 se zyada links convert nahi.`, parseMode: 'html' });
    }

    const urls = detectAllUrls(text);
    if (urls.length === 0) return;

    if (urls.length === 1) {
      const status = await client.sendMessage(chatId, { message: `⚡ <i>Link convert ho raha hai...</i>`, parseMode: 'html' });
      try {
        const result = await shortenUrl(urls[0], uid);
        await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { links_count: (user.links_count || 0) + 1 });
        const report = `✅ <b>Link Converted!</b>\n\n` +
          `<b>Original:</b>\n${escapeHtml(urls[0])}\n\n` +
          `<b>Smart Link:</b>\n${result.short}\n\n` +
          `📊 <b>Details</b>\n` +
          `👤 <b>Type:</b> ${getDomainName(urls[0])}\n` +
          `🟢 <b>Status:</b> Active\n` +
          `📱 <b>App:</b> Direct open / Download page\n` +
          `📅 <b>Created:</b> ${new Date().toLocaleString()}\n` +
          `♾️ <b>Valid:</b> Permanent`;
        const rows = [
          [{ text: '🔗 Open Link', url: result.short }],
          [{ text: '📋 Copy Link', callback_data: 'copy_' + result.slug }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }],
        ];
        await client.editMessage(chatId, { message: status.id, text: report, parseMode: 'html', buttons: keyboard(rows) });
      } catch (e) {
        await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
      }
      return;
    }

    const status = await client.sendMessage(chatId, {
      message: `⏳ <b>Processing ${urls.length} links...</b>`, parseMode: 'html',
    });

    const startTime = Date.now();
    try {
      const CONCURRENCY = 50;
      const results = [];
      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(url => shortenUrl(url, uid).then(r => ({ original: url, ...r })).catch(e => ({ original: url, error: e.message })))
        );
        results.push(...batchResults);
      }
      const successful = results.filter(r => !r.error);
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { links_count: (user.links_count || 0) + successful.length });
      const timeTaken = ((Date.now() - startTime) / 1000).toFixed(1);
      let reportText = `✅ <b>Conversion Complete!</b>\n\n` +
        `📊 Total: ${urls.length}\n` +
        `✅ Converted: ${successful.length}\n` +
        `⏱️ Time: ${timeTaken}s\n\n` +
        `📋 <b>Sample:</b>\n`;
      for (let i = 0; i < Math.min(5, successful.length); i++) {
        reportText += `${i + 1}. ${successful[i].short}\n`;
      }
      await client.editMessage(chatId, { message: status.id, text: reportText, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]]) });
    } catch (e) {
      await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
    }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const msgId = q.msgId;
    try { await q.answer(); } catch (e) {}

    const uid = q.userId;
    let user = await getUser(uid);
    if (!user) user = await createUser(uid, 'user');

    if (data === 'menu_convert') {
      await client.editMessage(chatId, { message: msgId, text: `🔗 <b>Convert Link</b>\n\nLink bhejo, main smart short link bana dunga.\n\n📱 <b>App installed:</b> Direct app khulega\n📲 <b>App nahi hai:</b> Download page khulega\n\n<b>Example:</b>\nhttps://example.com/abc`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_bulk') {
      await client.editMessage(chatId, { message: msgId, text: `🗂 <b>Bulk Link Converter</b>\n\n1000+ links ek saath — Super Fast!\n\n<b>Steps:</b>\n1. Ek line me ek link\n2. 1000+ links supported\n3. Kuch second me convert\n\n<b>Rate Limit:</b> 60/min\n\n<b>Sample:</b>\nhttps://example.com/abc\nhttps://youtube.com/watch?v=xyz`, parseMode: 'html', buttons: keyboard([[{ text: '📥 Sample', callback_data: 'copy_sample' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_income') {
      const balance = parseFloat(user.balance || 0).toFixed(2);
      await client.editMessage(chatId, { message: msgId, text: `💰 <b>Your Income</b>\n\n<b>Total Earnings:</b> ₹${balance}\n<b>Clicks:</b> ${user.clicks || 0}\n<b>Links:</b> ${user.links_count || 0}\n\n💡 Per click ₹0.05`, parseMode: 'html', buttons: keyboard([[{ text: '💸 Withdraw', callback_data: 'withdraw' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_transfer') {
      await client.editMessage(chatId, { message: msgId, text: `📊 <b>View Transfer</b>\n\nAbhi koi transfer nahi hai.\n\nTotal: ${user.links_count || 0} links\nBalance: ₹${parseFloat(user.balance || 0).toFixed(2)}`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_allbots') {
      await client.editMessage(chatId, { message: msgId, text: `🤖 <b>All Bots</b>\n\n🔗 Link Converter (Active)\n💰 Earning Bot (Active)\n📝 Content Bot (Active)\n🎬 Video Bot (Active)\n🌐 Web Bot (Active)\n\n<i>Sabka data safe 🔒</i>`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_api') {
      await client.editMessage(chatId, { message: msgId, text: `🔌 <b>API Connect</b>\n\n<b>Your API Key:</b>\n<code>${user.api_key}</code>`, parseMode: 'html', buttons: keyboard([[{ text: '📖 API Docs', callback_data: 'api_docs' }], [{ text: '🔄 Reset', callback_data: 'reset_api' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_account') {
      await client.editMessage(chatId, { message: msgId, text: `👤 <b>Account</b>\n\n<b>Username:</b> @${user.username}\n<b>User ID:</b> ${user.id}\n<b>Links:</b> ${user.links_count || 0}\n<b>Clicks:</b> ${user.clicks || 0}\n<b>Balance:</b> ₹${parseFloat(user.balance || 0).toFixed(2)}`, parseMode: 'html', buttons: keyboard([[{ text: '🔄 Reset API', callback_data: 'reset_api' }], [{ text: '🛡️ Privacy', callback_data: 'privacy' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'menu_logout') {
      await client.editMessage(chatId, { message: msgId, text: `🚪 <b>Logout</b>\n\nConfirm?`, parseMode: 'html', buttons: keyboard([[{ text: '✅ Confirm', callback_data: 'confirm_logout' }], [{ text: '❌ Cancel', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'main_menu') { await sendMenu(chatId, msgId); return; }

    if (data === 'reset_api') {
      const newKey = crypto.randomBytes(16).toString('hex');
      await sbPatch('users', `?id=eq.${encodeURIComponent(String(uid))}`, { api_key: newKey });
      await client.editMessage(chatId, { message: msgId, text: `✅ <b>API Reset!</b>\n\n<code>${newKey}</code>`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'privacy') {
      await client.editMessage(chatId, { message: msgId, text: `🛡️ <b>Privacy</b>\n\n✅ Encrypted storage\n✅ HMAC signed links\n✅ No data sharing\n✅ Safe & Secure`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'api_docs') {
      await client.editMessage(chatId, { message: msgId, text: `📖 <b>API Docs</b>\n\n<b>POST</b> https://${SHORT_DOMAIN}/api/shorten\n\n<b>Headers:</b>\n<code>x-api-key: ${user.api_key}</code>\n\n<b>Body:</b>\n<code>{"url":"https://example.com"}</code>`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'confirm_logout') {
      await client.editMessage(chatId, { message: msgId, text: `✅ Logout successful. /start bhejein.`, parseMode: 'html' });
      return;
    }

    if (data === 'withdraw') {
      await client.editMessage(chatId, { message: msgId, text: `💸 <b>Withdraw</b>\n\nMinimum: ₹500\n\nMethods: UPI, Paytm, Bank\n\nBalance: ₹${parseFloat(user.balance || 0).toFixed(2)}`, parseMode: 'html', buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]) });
      return;
    }

    if (data === 'copy_sample') {
      await client.sendMessage(chatId, { message: `<b>Sample:</b>\n<code>https://example.com/abc\nhttps://youtube.com/watch?v=xyz</code>`, parseMode: 'html' });
      return;
    }

    if (data.startsWith('copy_')) {
      const slug = data.replace('copy_', '');
      const sig = signSlug(slug);
      const link = `https://${SHORT_DOMAIN}/${slug}${sig}`;
      await client.sendMessage(chatId, { message: `📋 <b>Link:</b>\n<code>${link}</code>`, parseMode: 'html' });
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready - MayaJaal Converter (Smart App Links)');
})();
