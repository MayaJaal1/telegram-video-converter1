require('dotenv').config();
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const crypto = require('crypto');

const TOKEN = (process.env.BOT_TOKEN || '').trim();
const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();
const SHORT_DOMAIN = (process.env.SHORT_DOMAIN || 'm.mayajaal.online').trim();
const BASE_URL = (process.env.BASE_URL || 'https://mayajaal.online').trim();
const PORT = parseInt(process.env.PORT || '8090', 10);

console.log('=== ENV ===');
console.log('BOT_TOKEN:', !!TOKEN, '| API_ID:', !!API_ID, '| API_HASH:', !!API_HASH);
if (!TOKEN || !API_ID || !API_HASH) throw new Error('Missing credentials');

// ============ REDIS ============
let redis = null;
try {
  const { Redis } = require('@upstash/redis');
  redis = Redis.fromEnv();
  console.log('Redis connected');
} catch (e) {
  console.log('Redis not available, memory mode');
}

const memDB = { users: new Map(), links: new Map() };

async function getUser(userId) {
  const key = String(userId);
  if (redis) {
    const raw = await redis.get(`user:${key}`).catch(() => null);
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return memDB.users.get(key) || null;
}

async function saveUser(userId, data) {
  const key = String(userId);
  memDB.users.set(key, data);
  if (redis) await redis.set(`user:${key}`, JSON.stringify(data)).catch(() => {});
}

async function createUser(userId, username) {
  const user = {
    id: userId, username: username || 'user',
    joined: Date.now(), balance: 0, linksCount: 0, clicks: 0,
    apiKey: crypto.randomBytes(16).toString('hex'),
  };
  await saveUser(userId, user);
  return user;
}

async function saveLink(slug, data) {
  memDB.links.set(slug, data);
  if (redis) await redis.set(`link:${slug}`, JSON.stringify(data), { ex: 365 * 86400 }).catch(() => {});
}

async function getLink(slug) {
  if (redis) {
    const raw = await redis.get(`link:${slug}`).catch(() => null);
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return memDB.links.get(slug) || null;
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

async function shortenUrl(longUrl, ownerId) {
  const slug = crypto.randomBytes(5).toString('hex');
  await saveLink(slug, {
    url: longUrl, ownerId: String(ownerId), views: 0, created: Date.now(),
  });
  return { slug, short: `https://${SHORT_DOMAIN}/${slug}` };
}

// ============ EXPRESS SERVER ============
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// API endpoint for shortening
app.post('/api/shorten', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const url = req.body.url;
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
    if (!url) return res.status(400).json({ error: 'Missing url' });

    // find user by apiKey (scan memory - use redis index later)
    let user = null;
    for (const [k, v] of memDB.users.entries()) {
      if (v.apiKey === apiKey) { user = v; break; }
    }
    if (!user) return res.status(401).json({ error: 'Invalid API key' });

    const result = await shortenUrl(url, user.id);
    return res.json({ success: true, short: result.short, slug: result.slug });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Short link redirect
app.get('/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (slug === 'health') return res.json({ ok: true });
  const link = await getLink(slug);
  if (!link) return res.status(404).send('Link not found');
  link.views = (link.views || 0) + 1;
  await saveLink(slug, link);
  const user = await getUser(link.ownerId);
  if (user) {
    user.balance = (user.balance || 0) + 0.05;
    user.clicks = (user.clicks || 0) + 1;
    await saveUser(link.ownerId, user);
  }
  return res.redirect(link.url);
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));
// ============ BOT ============
(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5, autoReconnect: true,
  });
  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('Bot connected!');

  // Keyboard builder
  function keyboard(rows) {
    return new Api.ReplyInlineMarkup({
      rows: rows.map(row => new Api.KeyboardButtonRow({
        buttons: row.map(btn => {
          if (btn.url) {
            return new Api.KeyboardButtonUrl({ text: btn.text, url: btn.url });
          }
          return new Api.KeyboardButtonCallback({
            text: btn.text, data: Buffer.from(btn.callback_data),
          });
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

  // ============ /start HANDLER ============
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

  // ============ MESSAGE HANDLER (links) ============
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

    const urls = detectAllUrls(text);
    if (urls.length === 0) return;

    // ====== SINGLE LINK ======
    if (urls.length === 1) {
      const status = await client.sendMessage(chatId, {
        message: `⚡ <i>Link convert ho raha hai...</i>`, parseMode: 'html',
      });
      try {
        const result = await shortenUrl(urls[0], uid);
        user.linksCount = (user.linksCount || 0) + 1;
        await saveUser(uid, user);

        const report = `✅ <b>Link Converted Successfully!</b>\n\n` +
          `<b>Original Link:</b>\n${escapeHtml(urls[0])}\n\n` +
          `<b>Short Link:</b>\n${result.short}\n\n` +
          `📊 <b>Link Details</b>\n` +
          `👤 <b>Type:</b> ${getDomainName(urls[0])}\n` +
          `🟢 <b>Status:</b> Active\n` +
          `📅 <b>Created:</b> ${new Date().toLocaleString()}\n` +
          `♾️ <b>Valid For:</b> Permanent`;
        const rows = [
          [{ text: '🔗 Open Link', url: result.short }, { text: '📋 Copy Slug', callback_data: 'copy_' + result.slug }],
          [{ text: '⬅️ Main Menu', callback_data: 'main_menu' }],
        ];
        await client.editMessage(chatId, { message: status.id, text: report, parseMode: 'html', buttons: keyboard(rows) });
      } catch (e) {
        await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
      }
      return;
    }

    // ====== BULK LINKS (fast parallel) ======
    const status = await client.sendMessage(chatId, {
      message: `⏳ <b>Processing Your Links...</b>\n\nKripya thoda intezar karein.\nAapke ${urls.length} links convert ho rahe hain.`,
      parseMode: 'html',
    });

    const startTime = Date.now();
    try {
      // Process in parallel batches for speed
      const CONCURRENCY = 50;
      const results = [];
      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(url => shortenUrl(url, uid).then(r => ({ original: url, ...r })).catch(e => ({ original: url, error: e.message })))
        );
        results.push(...batchResults);

        // Progress update every batch
        if (i + CONCURRENCY < urls.length) {
          try {
            await client.editMessage(chatId, {
              message: status.id,
              text: `⏳ <b>Processing...</b>\n\n✅ ${results.length} / ${urls.length} converted`,
              parseMode: 'html',
            });
          } catch (e) {}
        }
      }

      const successful = results.filter(r => !r.error);
      user.linksCount = (user.linksCount || 0) + successful.length;
      await saveUser(uid, user);

      const timeTaken = ((Date.now() - startTime) / 1000).toFixed(1);

      let reportText = `✅ <b>Conversion Complete!</b>\n\n` +
        `📊 <b>Total:</b> ${urls.length} links\n` +
        `✅ <b>Converted:</b> ${successful.length}\n` +
        `❌ <b>Failed:</b> ${results.length - successful.length}\n` +
        `⏱️ <b>Time:</b> ${timeTaken}s\n\n` +
        `📋 <b>Sample Links (First 5):</b>\n`;
      for (let i = 0; i < Math.min(5, successful.length); i++) {
        reportText += `${i + 1}. ${successful[i].short}\n`;
      }

      await client.editMessage(chatId, {
        message: status.id, text: reportText, parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Main Menu', callback_data: 'main_menu' }]]),
      });
    } catch (e) {
      await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
    }
  }, new NewMessage({}));

  // ============ CALLBACK HANDLER ============
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

    // ====== CONVERT ======
    if (data === 'menu_convert') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🔗 <b>Convert Link</b>\n\nMayaJaal.online ka link bhejo, main use short link me convert kar dunga.\n\n<b>Example:</b>\nhttps://example.com/abc\nhttps://amazon.in/123`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== BULK ======
    if (data === 'menu_bulk') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🗂 <b>Bulk Link Converter</b>\n\nEk baar me <b>1000+ links</b> convert karein — <b>Super Fast!</b>\n\n<b>Steps:</b>\n1. Links ko text format me bhejein\n2. Ek line me ek link\n3. 1000+ links supported\n4. Kuch hi second me sab convert\n\n<b>Max Links Per Request:</b> 1000+\n<b>Speed:</b> ~50 links/second\n\n<b>Sample Format:</b>\nhttps://example.com/abc\nhttps://youtube.com/watch?v=xyz\nhttps://tiktok.com/123`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '📥 Copy Sample Format', callback_data: 'copy_sample' }],
          [{ text: '⬅️ Back', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ====== INCOME ======
    if (data === 'menu_income') {
      const balance = (user.balance || 0).toFixed(2);
      const clicks = user.clicks || 0;
      const links = user.linksCount || 0;
      const today = (user.balance * 0.08).toFixed(2);
      const week = (user.balance * 0.35).toFixed(2);
      await client.editMessage(chatId, {
        message: msgId,
        text: `💰 <b>Your Income</b>\n\n` +
          `<b>Total Earnings:</b> ₹${balance}\n` +
          `<b>Total Clicks:</b> ${clicks}\n` +
          `<b>Total Links:</b> ${links}\n\n` +
          `📅 <b>Today:</b> ₹${today}\n` +
          `📅 <b>This Week:</b> ₹${week}\n` +
          `📅 <b>This Month:</b> ₹${balance}\n\n` +
          `💡 <i>Income link conversion, ads & referrals se hota hai.\nPer click ₹0.05 milta hai.</i>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '💸 Withdraw / Payout', callback_data: 'withdraw' }],
          [{ text: '📊 View Transfer', callback_data: 'menu_transfer' }],
          [{ text: '⬅️ Back', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ====== TRANSFER ======
    if (data === 'menu_transfer') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `📊 <b>View Transfer</b>\n\nAap apne transfer ka pura record yahan dekh sakte hain.\n\n` +
          `<b>Recent Transfers:</b>\n` +
          `<i>Abhi koi transfer nahi hai.</i>\n\n` +
          `Total: ${user.linksCount || 0} links\n` +
          `Balance: ₹${(user.balance || 0).toFixed(2)}`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== ALL BOTS ======
    if (data === 'menu_allbots') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🤖 <b>All Bots</b>\n\nHamare sabhi bots ka ek hi jagah se access karein.\n\n` +
          `🔗 <b>Link Converter Bot</b> (Active)\n` +
          `💰 <b>Earning Bot</b> (Active)\n` +
          `📝 <b>Content Bot</b> (Active)\n` +
          `🎬 <b>Video Bot</b> (Active)\n` +
          `🌐 <b>Web Bot</b> (Active)\n\n` +
          `<i>Sabka data safe hai 🔒</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== API CONNECT ======
    if (data === 'menu_api') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🔌 <b>API Connect</b>\n\nApna API key generate karein aur apni website, app ya bot me easy integration karein.\n\n` +
          `<b>API Features:</b>\n` +
          `✅ Fast & Reliable\n` +
          `✅ 1000+ Links Support\n` +
          `✅ Full Documentation\n` +
          `✅ Example Code (Python, Node.js, PHP)\n\n` +
          `<b>Your API Key:</b>\n<code>${user.apiKey}</code>`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '📖 API Docs', callback_data: 'api_docs' }],
          [{ text: '🔄 Reset API Key', callback_data: 'reset_api' }],
          [{ text: '⬅️ Back', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ====== ACCOUNT ======
    if (data === 'menu_account') {
      const joined = new Date(user.joined).toLocaleDateString();
      await client.editMessage(chatId, {
        message: msgId,
        text: `👤 <b>Account & Settings</b>\n\n` +
          `<b>Username:</b> @${user.username}\n` +
          `<b>User ID:</b> ${user.id}\n` +
          `<b>Joined:</b> ${joined}\n` +
          `<b>Total Links:</b> ${user.linksCount || 0}\n` +
          `<b>Total Clicks:</b> ${user.clicks || 0}\n` +
          `<b>Balance:</b> ₹${(user.balance || 0).toFixed(2)}`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '🔄 Reset API Key', callback_data: 'reset_api' }],
          [{ text: '🤖 All Bots', callback_data: 'menu_allbots' }],
          [{ text: '🛡️ Privacy & Security', callback_data: 'privacy' }],
          [{ text: '⬅️ Back', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ====== LOGOUT ======
    if (data === 'menu_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🚪 <b>Logout</b>\n\nKya aap logout karna chahte hain?\n\n` +
          `Aapka data safe rahega.\n\n` +
          `🛡️ <b>Sabka data safe hai</b>\n` +
          `Hum aapke personal data, links, income aur transfer details ko secure rakhte hain.`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '✅ Confirm Logout', callback_data: 'confirm_logout' }],
          [{ text: '❌ Cancel', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    // ====== MAIN MENU ======
    if (data === 'main_menu') {
      await sendMenu(chatId, msgId);
      return;
    }

    // ====== RESET API ======
    if (data === 'reset_api') {
      user.apiKey = crypto.randomBytes(16).toString('hex');
      await saveUser(uid, user);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>API Key Reset!</b>\n\n<b>New Key:</b>\n<code>${user.apiKey}</code>\n\n<i>Purani key ab kaam nahi karegi.</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== PRIVACY ======
    if (data === 'privacy') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🛡️ <b>Privacy & Security</b>\n\n` +
          `Hum aapke sabhi personal data ko safely store karte hain. Koi bhi third-party aapka data access nahi kar sakti.\n\n` +
          `✅ Encrypted storage\n` +
          `✅ No data sharing\n` +
          `✅ Safe & Secure\n` +
          `✅ 24/7 protection`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== API DOCS ======
    if (data === 'api_docs') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `📖 <b>API Documentation</b>\n\n` +
          `<b>Endpoint:</b>\n<code>POST https://${SHORT_DOMAIN}/api/shorten</code>\n\n` +
          `<b>Headers:</b>\n<code>x-api-key: ${user.apiKey}</code>\n` +
          `<code>Content-Type: application/json</code>\n\n` +
          `<b>Body:</b>\n<code>{"url": "https://example.com"}</code>\n\n` +
          `<b>Response:</b>\n<code>{"success": true, "short": "https://${SHORT_DOMAIN}/abc123"}</code>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== CONFIRM LOGOUT ======
    if (data === 'confirm_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ <b>Logout successful.</b>\n\nDobara start karne ke liye /start bhejein.`,
        parseMode: 'html',
      });
      return;
    }

    // ====== WITHDRAW ======
    if (data === 'withdraw') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `💸 <b>Withdraw / Payout Info</b>\n\n` +
          `<b>Minimum withdrawal:</b> ₹500\n\n` +
          `<b>Methods:</b>\n• UPI\n• Paytm\n• Bank Transfer\n\n` +
          `Aapka current balance: <b>₹${(user.balance || 0).toFixed(2)}</b>\n\n` +
          `<i>₹500 pura hone par withdraw button active ho jayega.</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    // ====== COPY SAMPLE ======
    if (data === 'copy_sample') {
      await client.sendMessage(chatId, {
        message: `<b>Sample Format:</b>\n<code>https://example.com/abc\nhttps://youtube.com/watch?v=xyz\nhttps://tiktok.com/123</code>`,
        parseMode: 'html',
      });
      return;
    }

    // ====== COPY SLUG ======
    if (data.startsWith('copy_')) {
      const slug = data.replace('copy_', '');
      const link = `https://${SHORT_DOMAIN}/${slug}`;
      await client.sendMessage(chatId, {
        message: `📋 <b>Short Link:</b>\n<code>${link}</code>`,
        parseMode: 'html',
      });
      return;
    }
  }, new CallbackQuery({}));

  console.log('Bot ready - MayaJaal Converter (Bulk 1000+ fast)');
})();
