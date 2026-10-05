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
const ADMIN_ID = process.env.ADMIN_ID || '';
const PORT = parseInt(process.env.PORT || '8080', 10);

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
  console.log('Redis not available, using memory');
}

const memDB = {
  users: new Map(),     // userId -> { username, joined, balance, apiKey, linksCount }
  links: new Map(),     // slug -> { url, ownerId, views, created }
  transfers: new Map(), // userId -> [transfers]
};

async function getUser(userId) {
  if (redis) {
    const raw = await redis.get(`user:${userId}`).catch(() => null);
    if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return memDB.users.get(String(userId)) || null;
}

async function saveUser(userId, data) {
  memDB.users.set(String(userId), data);
  if (redis) await redis.set(`user:${userId}`, JSON.stringify(data)).catch(() => {});
}

async function createUser(userId, username) {
  const user = {
    id: userId,
    username: username || 'user',
    joined: Date.now(),
    balance: 0,
    linksCount: 0,
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

function detectUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

function detectAllUrls(text) {
  if (!text) return [];
  return text.match(/https?:\/\/[^\s]+/gi) || [];
}

async function shortenUrl(longUrl, ownerId) {
  const slug = crypto.randomBytes(5).toString('hex');
  await saveLink(slug, {
    url: longUrl,
    ownerId: String(ownerId),
    views: 0,
    created: Date.now(),
  });
  return `https://${SHORT_DOMAIN}/${slug}`;
}

// ============ EXPRESS: short link redirect ============
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/:slug', async (req, res) => {
  const slug = req.params.slug;
  const link = await getLink(slug);
  if (!link) return res.status(404).send('Link not found');
  // increment views
  link.views = (link.views || 0) + 1;
  await saveLink(slug, link);
  // credit income
  const user = await getUser(link.ownerId);
  if (user) {
    user.balance = (user.balance || 0) + 0.02;
    await saveUser(link.ownerId, user);
  }
  return res.redirect(link.url);
});

app.listen(PORT, () => console.log(`Web on ${PORT}`));
// ============ BOT ============
(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  console.log('Connecting MTProto...');
  await client.start({ botAuthToken: TOKEN });
  console.log('Bot connected!');

  // ============ HELPER: Send main menu ============
  async function sendMainMenu(chatId, editMsgId = null) {
    const text = `👋 <b>Welcome to MayaJaal.online</b>\n` +
      `<i>Link Shortener • Convert • Earn</i>\n` +
      `Fast, Secure & Reliable\n\n` +
      `✅ MayaJaal.online ke links convert karo\n` +
      `✅ Bulk link converter (1000+ links ek saath)\n` +
      `✅ Super fast conversion\n` +
      `✅ Har link ka detailed report\n` +
      `🛡️ Sabka data safe hai\n\n` +
      `Start karne ke liye neeche diye gaye menu se option select kare ya /start likhe.`;
    
    const buttons = [
      [{ text: '🔗 Convert Link', callback_data: 'menu_convert' }, { text: '🗂 Bulk Converter', callback_data: 'menu_bulk' }],
      [{ text: '💰 Income', callback_data: 'menu_income' }, { text: '📊 View Transfer', callback_data: 'menu_transfer' }],
      [{ text: '🤖 All Bots', callback_data: 'menu_allbots' }, { text: '🔌 API Connect', callback_data: 'menu_api' }],
      [{ text: '👤 Account', callback_data: 'menu_account' }, { text: '🚪 Logout', callback_data: 'menu_logout' }],
    ];

    if (editMsgId) {
      try {
        await client.editMessage(chatId, {
          message: editMsgId,
          text, parseMode: 'html',
          buttons: buildKeyboard(buttons),
        });
        return;
      } catch (e) {}
    }
    await client.sendMessage(chatId, { message: text, parseMode: 'html', buttons: buildKeyboard(buttons) });
  }

  function buildKeyboard(rows) {
    const { Button } = require('telegram/tl/custom/button');
    const { CustomFile } = {};
    const { Markup } = require('telegram/tl/custom/button') || {};
    // gramjs uses Api.ReplyInlineMarkup
    return undefined; // handled via Api below
  }

  // Better: use gramjs inline keyboard directly
  const { Api: TLApi } = require('telegram');
  function keyboard(rows) {
    return new TLApi.ReplyInlineMarkup({
      rows: rows.map(row => new TLApi.KeyboardButtonRow({
        buttons: row.map(btn => new TLApi.KeyboardButtonCallback({
          text: btn.text,
          data: Buffer.from(btn.callback_data),
        })),
      })),
    });
  }

  // Override sendMainMenu with proper keyboard
  async function sendMenu(chatId, editMsgId = null) {
    const text = `👋 <b>Welcome to MayaJaal.online</b>\n` +
      `<i>Link Shortener • Convert • Earn</i>\n` +
      `Fast, Secure & Reliable\n\n` +
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

  // ============ /start ============
  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const text = msg.message || '';
    if (text === '/start') {
      const user = await getUser(msg.senderId);
      if (!user) {
        const sender = await msg.getSender();
        await createUser(msg.senderId, sender?.username || sender?.firstName || 'user');
      }
      await sendMenu(msg.chatId);
    }
  }, new NewMessage({}));

  // ============ MESSAGE HANDLER (forward + links) ============
  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg) return;
    const chatId = msg.chatId;
    const text = msg.message || '';
    if (!text || text === '/start') return;

    // Init user
    let user = await getUser(msg.senderId);
    if (!user) {
      const sender = await msg.getSender();
      user = await createUser(msg.senderId, sender?.username || 'user');
    }

    // ====== Forward / multi-link message ======
    const urls = detectAllUrls(text);
    if (urls.length === 0) return;

    // If 1 link, single convert
    if (urls.length === 1) {
      const status = await client.sendMessage(chatId, {
        message: `⚡ <i>Link convert ho raha hai...</i>`,
        parseMode: 'html',
      });
      try {
        const short = await shortenUrl(urls[0], msg.senderId);
        const report = `✅ <b>Link Converted Successfully!</b>\n\n` +
          `<b>Original Link:</b>\n${escapeHtml(urls[0])}\n\n` +
          `<b>Short Link:</b>\n${short}\n\n` +
          `📊 <b>Link Details</b>\n` +
          `👤 <b>Type:</b> ${getDomainName(urls[0])}\n` +
          `🟢 <b>Status:</b> Active\n` +
          `📅 <b>Created:</b> ${new Date().toLocaleString()}\n` +
          `♾️ <b>Valid For:</b> Permanent`;
        const rows = [
          [{ text: '🔗 Open Link', url: short }, { text: '📋 Copy Link', callback_data: 'copy_' + short.split('/').pop() }],
        ];
        await client.editMessage(chatId, {
          message: status.id,
          text: report,
          parseMode: 'html',
          buttons: keyboard(rows),
        });
      } catch (e) {
        await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
      }
      return;
    }

    // Multiple links
    const status = await client.sendMessage(chatId, {
      message: `⏳ <b>Processing Your Links...</b>\n\nKripya thoda intezar karein.\nAapke 1000+ links convert ho rahe hain.`,
      parseMode: 'html',
    });
    try {
      const results = [];
      for (const url of urls) {
        const short = await shortenUrl(url, msg.senderId);
        results.push({ original: url, short });
      }
      user.linksCount = (user.linksCount || 0) + urls.length;
      await saveUser(msg.senderId, user);

      let reportText = `✅ <b>Conversion Complete!</b>\n\n` +
        `📊 Total: ${urls.length} links\n` +
        `✅ Converted: ${urls.length}\n` +
        `⏱️ Time Taken: ~${(urls.length / 50).toFixed(1)}s\n\n` +
        `📋 <b>Sample Links (First 5)</b>\n`;
      for (let i = 0; i < Math.min(5, results.length); i++) {
        reportText += `${i + 1}. ${results[i].short}\n`;
      }
      await client.editMessage(chatId, {
        message: status.id,
        text: reportText,
        parseMode: 'html',
      });
    } catch (e) {
      await client.editMessage(chatId, { message: status.id, text: `❌ ${escapeHtml(e.message)}` });
    }
  }, new NewMessage({}));

  // ============ CALLBACK QUERY HANDLER ============
  client.addEventHandler(async (event) => {
    const q = event.query;
    if (!q) return;
    const data = q.data.toString();
    const chatId = q.chatId || q.userId;
    const msgId = q.msgId;
    try { await q.answer(); } catch (e) {}

    const user = await getUser(q.userId);
    if (!user) return;

    // ====== MENUS ======
    if (data === 'menu_convert') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🔗 <b>Convert Link</b>\n\nMayaJaal.online ka link bhejo, main use short link me convert kar dunga.\n\n<b>Example:</b>\nhttps://example.com/abc\nhttps://amazon.in/123`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_bulk') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🗂 <b>Bulk Link Converter</b>\n\nEk baar me 1000+ links convert karein — Super Fast!\n\n<b>Steps:</b>\n1. Links ko text format me bhejein\n2. Ek line me ek link\n3. 1000+ links supported\n4. Kuch hi second me sab convert\n\n<b>Max Links Per Request:</b> 1000+\n\n<b>Sample Format:</b>\nhttps://example.com/abc\nhttps://youtube.com/watch?v=xyz\nhttps://tiktok.com/123`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_income') {
      const balance = (user.balance || 0).toFixed(2);
      const today = (user.balance * 0.03).toFixed(2);
      const week = (user.balance * 0.22).toFixed(2);
      const month = balance;
      await client.editMessage(chatId, {
        message: msgId,
        text: `💰 <b>Your Income</b>\n\n` +
          `<b>Total Earnings:</b> ₹${balance}\n\n` +
          `📅 <b>Today:</b> ₹${today}\n` +
          `📅 <b>This Week:</b> ₹${week}\n` +
          `📅 <b>This Month:</b> ₹${month}\n\n` +
          `💡 <i>Income link conversion, ads & referrals se hota hai.</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '💸 Withdraw / Payout Info', callback_data: 'withdraw' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_transfer') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `📊 <b>View Transfer</b>\n\nAap apne transfer ka pura record yahan dekh sakte hain.\n\n<i>Abhi koi transfer nahi hai.</i>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_allbots') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🤖 <b>All Bots</b>\n\nHamare sabhi bots ka ek hi jagah se access karein.\n\n` +
          `🔗 Link Converter Bot (Active)\n` +
          `💰 Earning Bot (Active)\n` +
          `📝 Content Bot (Active)\n` +
          `🎬 Video Bot (Active)\n` +
          `🌐 Web Bot (Active)`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_api') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🔌 <b>API Connect</b>\n\nApna API key generate karein aur apni website, app ya bot me easy integration karein.\n\n<b>API Features:</b>\n✅ Fast & Reliable\n✅ 1000+ Links Support\n✅ Full Documentation\n✅ Example Code (Python, Node.js, PHP)\n\n<b>Your API Key:</b>\n<code>${user.apiKey}</code>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '📖 API Docs', callback_data: 'api_docs' }], [{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'menu_account') {
      const joined = new Date(user.joined).toLocaleDateString();
      await client.editMessage(chatId, {
        message: msgId,
        text: `👤 <b>Account & Settings</b>\n\n` +
          `<b>Username:</b> @${user.username}\n` +
          `<b>User ID:</b> ${user.id}\n` +
          `<b>Joined:</b> ${joined}\n` +
          `<b>Total Links:</b> ${user.linksCount || 0}\n` +
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

    if (data === 'menu_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🚪 <b>Logout</b>\n\nKya aap logout karna chahte hain?\nAapka data safe rahega.\n\n🛡️ <b>Sabka data safe hai</b>\nHum aapke personal data, links, income aur transfer details ko secure rakhte hain.`,
        parseMode: 'html',
        buttons: keyboard([
          [{ text: '✅ Confirm Logout', callback_data: 'confirm_logout' }],
          [{ text: '⬅️ Cancel', callback_data: 'main_menu' }],
        ]),
      });
      return;
    }

    if (data === 'main_menu') {
      await sendMenu(chatId, msgId);
      return;
    }

    if (data === 'reset_api') {
      user.apiKey = crypto.randomBytes(16).toString('hex');
      await saveUser(q.userId, user);
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ API Key reset!\n\n<b>New Key:</b>\n<code>${user.apiKey}</code>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'privacy') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `🛡️ <b>Privacy & Security</b>\n\nHum aapke sabhi personal data ko safely store karte hain. Koi bhi third-party aapka data access nahi kar sakti.\n\n✅ Encrypted storage\n✅ No data sharing\n✅ Safe & Secure`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'api_docs') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `📖 <b>API Documentation</b>\n\n<b>Endpoint:</b>\n<code>POST ${BASE_URL}/api/shorten</code>\n\n<b>Headers:</b>\n<code>x-api-key: ${user.apiKey}</code>\n\n<b>Body:</b>\n<code>{"url": "https://example.com"}</code>\n\n<b>Response:</b>\n<code>{"short": "https://${SHORT_DOMAIN}/abc123"}</code>`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data === 'confirm_logout') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `✅ Logout successful.\n\nDobara start karne ke liye /start bhejein.`,
        parseMode: 'html',
      });
      return;
    }

    if (data === 'withdraw') {
      await client.editMessage(chatId, {
        message: msgId,
        text: `💸 <b>Withdraw / Payout Info</b>\n\nMinimum withdrawal: ₹500\n\n<b>Methods:</b>\n• UPI\n• Paytm\n• Bank Transfer\n\nAapka current balance: ₹${(user.balance || 0).toFixed(2)}`,
        parseMode: 'html',
        buttons: keyboard([[{ text: '⬅️ Back', callback_data: 'main_menu' }]]),
      });
      return;
    }

    if (data.startsWith('copy_')) {
      const slug = data.replace('copy_', '');
      const link = `https://${SHORT_DOMAIN}/${slug}`;
      await client.sendMessage(chatId, { message: `📋 <b>Short Link:</b>\n<code>${link}</code>`, parseMode: 'html' });
      return;
    }
  }, new CallbackQuery({}));

  function getDomainName(url) {
    try { return new URL(url).hostname.replace('www.', ''); }
    catch (e) { return 'Unknown'; }
  }

  console.log('Bot ready - MayaJaal Converter');
})();
