const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

const LANG = require('./languages');
const {
  BOT_TOKEN,
  OWNER_CHANNEL_ID,
  OWNER_ID,
  RATE_LIMIT_SECONDS,
  MAX_WARNINGS
} = require('./config');

/* ================== Express ================== */
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot running');
});

app.listen(PORT, () => {
  console.log('Web server running on port', PORT);
});

/* ================== Bot ================== */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ================== Storage ================== */
const DATA_FILE = './data.json';
const LOG_FILE = './logs.json';

let data = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE))
  : {};

let logs = fs.existsSync(LOG_FILE)
  ? JSON.parse(fs.readFileSync(LOG_FILE))
  : [];

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function saveLogs() {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function getUser(id) {
  if (!data[id]) {
    data[id] = {
      downloads: 0,
      warnings: 0,
      mode: 'video'
    };
  }
  return data[id];
}

/* ================== Helpers ================== */
const cooldown = new Map();

function notifyOwner(user, link, type) {
  const username = user.username ? `@${user.username}` : 'NoUsername';

  const text =
`✅ New Download (${type})
User: ${user.first_name || 'User'} (${username}, ID: ${user.id})
Link: ${link}`;

  bot.sendMessage(OWNER_CHANNEL_ID, text).catch(() => {});
}

function addLog(user, link, type) {
  logs.push({
    time: new Date().toISOString(),
    type,
    user: {
      id: user.id,
      name: user.first_name || 'User',
      username: user.username || null
    },
    link
  });
  saveLogs();
}

/* ================== Dashboard Auth ================== */
function auth(req, res, next) {
  if (req.query.owner != OWNER_ID) {
    return res.status(403).send('Forbidden');
  }
  next();
}

/* ================== Ban / Unban Routes ================== */
app.get('/ban', auth, (req, res) => {
  const userId = req.query.user;
  if (!userId || !data[userId]) {
    return res.send('User not found');
  }

  data[userId].warnings = MAX_WARNINGS;
  saveData();
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

app.get('/unban', auth, (req, res) => {
  const userId = req.query.user;
  if (!userId || !data[userId]) {
    return res.send('User not found');
  }

  data[userId].warnings = 0;
  saveData();
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

/* ================== Dashboard ================== */
app.get('/dashboard', auth, (req, res) => {
  const lastLogs = logs.slice(-20).reverse();

  const rows = lastLogs.map(l => {
    const banned =
      data[l.user.id] &&
      data[l.user.id].warnings >= MAX_WARNINGS;

    const actionButton = banned
      ? `<a href="/unban?owner=${OWNER_ID}&user=${l.user.id}" style="color:lightgreen">Unban</a>`
      : `<a href="/ban?owner=${OWNER_ID}&user=${l.user.id}" style="color:red">Ban</a>`;

    return `
<tr>
  <td>${l.time}</td>
  <td>${l.type}</td>
  <td>${l.user.id}</td>
  <td>${l.user.name}</td>
  <td>${l.user.username || '-'}</td>
  <td>${l.link}</td>
  <td>${actionButton}</td>
</tr>`;
  }).join('');

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Bot Dashboard</title>
<style>
body { font-family: Arial; background:#111; color:#eee; padding:20px; }
table { width:100%; border-collapse: collapse; margin-top:15px; }
th, td { border:1px solid #333; padding:6px; font-size:12px; }
th { background:#222; }
a { text-decoration:none; font-weight:bold; }
</style>
</head>
<body>

<h2>🤖 Telegram Bot Dashboard</h2>
<p>👥 Users: ${Object.keys(data).filter(k => !isNaN(k)).length}</p>
<p>⬇️ Downloads: ${logs.length}</p>

<table>
<tr>
<th>Time</th>
<th>Type</th>
<th>ID</th>
<th>Name</th>
<th>Username</th>
<th>Link</th>
<th>Action</th>
</tr>
${rows}
</table>

</body>
</html>
  `);
});

/* ================== API ================== */
app.get('/api/stats', auth, (req, res) => {
  res.json({
    status: 'online',
    users: Object.keys(data).filter(k => !isNaN(k)).length,
    downloads: logs.length
  });
});

app.get('/api/logs', auth, (req, res) => {
  res.json(logs.slice(-100).reverse());
});

/* ================== Bot Commands ================== */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, LANG.en.start);
});

bot.onText(/\/stats/, (msg) => {
  const u = getUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, LANG.en.stats(u.downloads, u.warnings));
});

bot.onText(/\/audio/, (msg) => {
  const u = getUser(msg.chat.id);
  u.mode = 'audio';
  saveData();
  bot.sendMessage(msg.chat.id, LANG.en.audioAsk);
});

/* ================== Main Handler ================== */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes('tiktok.com')) return;

  const u = getUser(chatId);

  if (u.warnings >= MAX_WARNINGS) {
    return bot.sendMessage(chatId, LANG.en.banned);
  }

  const last = cooldown.get(chatId) || 0;
  if (Date.now() - last < RATE_LIMIT_SECONDS * 1000) {
    u.warnings++;
    saveData();
    return bot.sendMessage(chatId, LANG.en.wait);
  }
  cooldown.set(chatId, Date.now());

  const loading = await bot.sendMessage(chatId, LANG.en.loading);

  try {
    axios.defaults.headers.common['User-Agent'] =
      'Mozilla/5.0 (TelegramBot)';

    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(text)}`;
    const res = await axios.get(apiUrl, { timeout: 15000 });
    const info = res.data?.data;
    if (!info) throw new Error('API error');

    await bot.deleteMessage(chatId, loading.message_id);

    if (u.mode === 'audio') {
      await bot.sendAudio(chatId, info.music, { title: 'TikTok MP3' });
      notifyOwner(msg.from, text, 'MP3');
      addLog(msg.from, text, 'MP3');
      u.mode = 'video';
    } else {
      await bot.sendVideo(chatId, info.play, {
        caption: LANG.en.success
      });
      notifyOwner(msg.from, text, 'Video');
      addLog(msg.from, text, 'Video');
    }

    u.downloads++;
    saveData();

  } catch (err) {
    bot.sendMessage(chatId, LANG.en.fail);

  notifyOwner(msg.from, text, 'error');
  }
});
