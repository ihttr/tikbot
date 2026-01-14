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

app.get('/', (_, res) => res.send('Bot running'));
app.listen(PORT, () => console.log('Web running on', PORT));

/* ================== Telegram Bot ================== */
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

const saveData = () =>
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
const saveLogs = () =>
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

function getUser(id) {
  if (!data[id]) {
    data[id] = {
      downloads: 0,
      warnings: 0,
      mode: 'video',
      banUntil: null
    };
  }
  return data[id];
}

/* ================== Helpers ================== */
const cooldown = new Map();

function notifyOwner(user, link, type) {
  const username = user.username ? `@${user.username}` : 'NoUsername';
  bot.sendMessage(
    OWNER_CHANNEL_ID,
`✅ New Download (${type})
User: ${user.first_name || 'User'} (${username}, ID: ${user.id})
Link: ${link}`
  ).catch(() => {});
}

function addLog({ user, link, type, status, error = null }) {
  logs.push({
    time: new Date().toISOString(),
    status,
    type,
    user: {
      id: user.id,
      name: user.first_name || 'User',
      username: user.username || null
    },
    link,
    error
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

/* ================== Ban / Unban / TempBan ================== */
app.get('/ban', auth, (req, res) => {
  const id = req.query.user;
  if (!data[id]) return res.send('User not found');
  data[id].warnings = MAX_WARNINGS;
  data[id].banUntil = null;
  saveData();
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

app.get('/unban', auth, (req, res) => {
  const id = req.query.user;
  if (!data[id]) return res.send('User not found');
  data[id].warnings = 0;
  data[id].banUntil = null;
  saveData();
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

app.get('/tempban', auth, (req, res) => {
  const { user, hours } = req.query;
  if (!data[user]) return res.send('User not found');

  data[user].banUntil = Date.now() + (Number(hours) * 60 * 60 * 1000);
  saveData();
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

/* ================== Retry ================== */
app.get('/retry', auth, async (req, res) => {
  const link = req.query.link;
  try {
    if (link) {
      await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(link)}`);
    }
  } catch {}
  res.redirect(`/dashboard?owner=${OWNER_ID}`);
});

/* ================== Logs Download ================== */
app.get('/download-logs', auth, (req, res) => {
  res.download(LOG_FILE);
});

/* ================== Charts API ================== */
app.get('/api/chart', auth, (req, res) => {
  const success = logs.filter(l => l.status === 'success').length;
  const failed = logs.filter(l => l.status === 'failed').length;
  res.json({ success, failed });
});

/* ================== Dashboard ================== */
app.get('/dashboard', auth, (req, res) => {
  let filteredLogs = logs;
  const filter = req.query.filter;

  if (filter === 'success') filteredLogs = logs.filter(l => l.status === 'success');
  if (filter === 'failed') filteredLogs = logs.filter(l => l.status === 'failed');

  const lastLogs = filteredLogs.slice(-20).reverse();
  const successCount = logs.filter(l => l.status === 'success').length;
  const failedCount = logs.filter(l => l.status === 'failed').length;

  const rows = lastLogs.map(l => {
    const u = data[l.user.id];
    const banned = u?.warnings >= MAX_WARNINGS;
    const tempBanned = u?.banUntil && Date.now() < u.banUntil;

    const banBtn = banned
      ? `<a href="/unban?owner=${OWNER_ID}&user=${l.user.id}" style="color:lightgreen">Unban</a>`
      : `<a href="/ban?owner=${OWNER_ID}&user=${l.user.id}" style="color:red">Ban</a>`;

    const tempBtn = `<a href="/tempban?owner=${OWNER_ID}&user=${l.user.id}&hours=24" style="color:orange">24h</a>`;
    const retryBtn = l.status === 'failed'
      ? ` | <a href="/retry?owner=${OWNER_ID}&link=${encodeURIComponent(l.link)}" style="color:cyan">Retry</a>`
      : '';

    return `
<tr>
<td>${l.time}</td>
<td>${l.user.id}</td>
<td>${l.user.name}</td>
<td>${l.user.username || '-'}</td>
<td style="color:${l.status === 'failed' ? 'red' : 'lightgreen'}">${l.status}</td>
<td>${l.error || '-'}</td>
<td>${tempBanned ? '⏱' : ''} ${banBtn} | ${tempBtn}${retryBtn}</td>
</tr>`;
  }).join('');

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Bot Dashboard</title>
<style>
body { font-family: Arial; background:#111; color:#eee; padding:20px; }
table { width:100%; border-collapse: collapse; margin-top:10px; }
th,td { border:1px solid #333; padding:6px; font-size:12px; }
th { background:#222; }
a { text-decoration:none; font-weight:bold; }
</style>
</head>
<body>

<h2>🤖 Telegram Bot Dashboard</h2>

<p>
<a href="/dashboard?owner=${OWNER_ID}">All</a> |
<a href="/dashboard?owner=${OWNER_ID}&filter=success" style="color:lightgreen">Success</a> |
<a href="/dashboard?owner=${OWNER_ID}&filter=failed" style="color:red">Failed</a>
</p>

<p>
👥 Users: ${Object.keys(data).filter(k => !isNaN(k)).length} |
⬇️ Downloads: ${logs.length} |
✅ ${successCount} / ❌ ${failedCount}
</p>

<p>
<a href="/download-logs?owner=${OWNER_ID}" style="color:cyan">⬇ Download Logs</a>
</p>

<canvas id="chart" height="80"></canvas>

<table>
<tr>
<th>Time</th>
<th>Type</th>
<th>Name</th>
<th>Username</th>
<th>Status</th>
<th>Error</th>
<th>Action</th>
</tr>
${rows}
</table>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
fetch('/api/chart?owner=${OWNER_ID}')
.then(r=>r.json())
.then(d=>{
  new Chart(document.getElementById('chart'), {
    type:'doughnut',
    data:{
      labels:['Success','Failed'],
      datasets:[{data:[d.success,d.failed]}]
    }
  });
});
</script>

</body>
</html>
`);
});

/* ================== Bot Commands ================== */
bot.onText(/\/start/, msg =>
  bot.sendMessage(msg.chat.id, LANG.en.start)
);

bot.onText(/\/stats/, msg => {
  const u = getUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, LANG.en.stats(u.downloads, u.warnings));
});

bot.onText(/\/audio/, msg => {
  const u = getUser(msg.chat.id);
  u.mode = 'audio';
  saveData();
  bot.sendMessage(msg.chat.id, LANG.en.audioAsk);
});

/* ================== Main Handler ================== */
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || !text.includes('tiktok.com')) return;

  const u = getUser(chatId);

  if (u.banUntil && Date.now() < u.banUntil)
    return bot.sendMessage(chatId, '⏱ You are temporarily banned');

  if (u.warnings >= MAX_WARNINGS)
    return bot.sendMessage(chatId, LANG.en.banned);

  const last = cooldown.get(chatId) || 0;
  if (Date.now() - last < RATE_LIMIT_SECONDS * 1000) {
    u.warnings++;
    saveData();
    return bot.sendMessage(chatId, LANG.en.wait);
  }
  cooldown.set(chatId, Date.now());

  const loading = await bot.sendMessage(chatId, LANG.en.loading);

  try {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(text)}`;
    const res = await axios.get(apiUrl, { timeout: 15000 });
    const info = res.data?.data;
    if (!info) throw new Error('API error');

    await bot.deleteMessage(chatId, loading.message_id);

    if (u.mode === 'audio') {
      await bot.sendAudio(chatId, info.music);
      notifyOwner(msg.from, text, 'MP3');
      addLog({ user: msg.from, link: text, type: 'MP3', status: 'success' });
      u.mode = 'video';
    } else {
      await bot.sendVideo(chatId, info.play);
      notifyOwner(msg.from, text, 'HQ');
      addLog({ user: msg.from, link: text, type: 'HQ', status: 'success' });
    }

    u.downloads++;
    saveData();

  } catch (err) {
    addLog({
      user: msg.from,
      link: text,
      type: u.mode === 'audio' ? 'MP3' : 'HQ',
      status: 'failed',
      error: err.message || 'Unknown error'
    });
    bot.sendMessage(chatId, LANG.en.fail);
  }
});