// Main bot file (shortened header)
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const express = require('express');
const LANG = require('./languages');
const { BOT_TOKEN, OWNER_CHANNEL_ID, OWNER_ID, RATE_LIMIT_SECONDS, MAX_WARNINGS } = require('./config');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.get('/', (_, res) => res.send('Bot running'));
app.listen(3000);

// Storage
const DATA_FILE = './data.json';
const LOG_FILE = './logs.json';
let data = JSON.parse(fs.readFileSync(DATA_FILE));
let logs = JSON.parse(fs.readFileSync(LOG_FILE));

function saveData(){ fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }
function saveLogs(){ fs.writeFileSync(LOG_FILE, JSON.stringify(logs,null,2)); }
function getUser(id){
  if(!data[id]) data[id]={downloads:0,warnings:0,mode:'video'};
  return data[id];
}

function notifyOwner(user, link, type){
  const username = user.username ? '@'+user.username : 'NoUsername';
  bot.sendMessage(OWNER_CHANNEL_ID,
`✅ New Download (${type})
User: ${user.first_name} (${username}, ID: ${user.id})
Link: ${link}`);
}

bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, LANG.en.start));

bot.onText(/\/stats/, msg => {
  const u=getUser(msg.chat.id);
  bot.sendMessage(msg.chat.id, LANG.en.stats(u.downloads,u.warnings));
});

bot.onText(/\/audio/, msg=>{
  getUser(msg.chat.id).mode='audio';
  saveData();
  bot.sendMessage(msg.chat.id, LANG.en.audioAsk);
});

const cooldown=new Map();

bot.on('message', async msg=>{
  const text=msg.text;
  if(!text || !text.includes('tiktok.com')) return;
  const u=getUser(msg.chat.id);

  if(u.warnings>=MAX_WARNINGS) return bot.sendMessage(msg.chat.id, LANG.en.banned);

  const last=cooldown.get(msg.chat.id)||0;
  if(Date.now()-last < RATE_LIMIT_SECONDS*1000){
    u.warnings++; saveData();
    return bot.sendMessage(msg.chat.id, LANG.en.wait);
  }
  cooldown.set(msg.chat.id, Date.now());

  const loading = await bot.sendMessage(msg.chat.id, LANG.en.loading);
  try{
    const res = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(text)}`);
    const info=res.data.data;
    await bot.deleteMessage(msg.chat.id, loading.message_id);

    if(u.mode==='audio'){
      await bot.sendAudio(msg.chat.id, info.music);
      notifyOwner(msg.from, text, 'MP3');
      u.mode='video';
    } else {
      await bot.sendVideo(msg.chat.id, info.play, {caption: LANG.en.success});
      notifyOwner(msg.from, text, 'HQ');
    }

    logs.push({time:new Date().toISOString(),type:u.mode,user:msg.from,link:text});
    u.downloads++;
    saveData(); saveLogs();
  }catch(e){
    bot.sendMessage(msg.chat.id, LANG.en.fail);
  }
});
