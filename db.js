// In-memory DB, persisted to local file + a Telegram channel (pinned document, edited in place).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { InputFile } = require('grammy');
const cfg = require('./config');
const { today, log, sleep } = require('./util');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'db.json');

const fresh = () => ({
  v: 2,
  users: {},
  accounts: {},
  admins: [],
  bannedTg: {},
  daily: {},
  settings: {}, // only admin overrides; defaults come from env (config.js)
  meta: { msgId: 0, savedAt: 0 },
});
const data = fresh();
let api = null, dirty = false, flushing = false;

const touch = () => { dirty = true; };
function adopt(obj) {
  const f = fresh();
  Object.assign(data, f, obj);
  data.settings = (obj.v || 1) < 2 ? {} : { ...(obj.settings || {}) }; // old versions stored defaults -> env wins
  data.v = 2;
  data.meta = { ...f.meta, ...(obj.meta || {}) };
}

async function fetchChannel() {
  const chat = await api.getChat(cfg.DB_CHANNEL_ID);
  const pm = chat.pinned_message;
  if (!pm || !pm.document) return null;
  const f = await api.getFile(pm.document.file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error('download ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return { obj: JSON.parse(zlib.gunzipSync(buf).toString('utf8')), msgId: pm.message_id };
}

async function load() {
  let loaded = false;
  if (cfg.DB_CHANNEL_ID) {
    let ok = false, res = null;
    for (let i = 0; i < 5 && !ok; i++) {
      try { res = await fetchChannel(); ok = true; }
      catch (e) { log('DB channel load failed:', e.message); await sleep(3000); }
    }
    if (!ok) { log('FATAL: cannot read DB channel (refusing to start with empty data)'); process.exit(1); }
    if (res) { adopt(res.obj); data.meta.msgId = res.msgId; loaded = true; log('DB loaded from channel'); }
  }
  if (!loaded && fs.existsSync(FILE)) {
    try { adopt(JSON.parse(fs.readFileSync(FILE, 'utf8'))); loaded = true; log('DB loaded from local file'); } catch (e) { log('local db bad', e.message); }
  }
  if (!loaded) { log('Fresh DB'); dirty = true; }
}

async function pushChannel(json) {
  const buf = zlib.gzipSync(Buffer.from(json));
  const caption = 'DB backup ' + new Date().toISOString();
  const file = () => new InputFile(buf, 'db.json.gz');
  if (data.meta.msgId) {
    try {
      await api.editMessageMedia(cfg.DB_CHANNEL_ID, data.meta.msgId, { type: 'document', media: file(), caption });
      return;
    } catch (e) {
      if (/not modified/i.test(e.description || e.message || '')) return;
      log('edit backup failed, posting new:', e.description || e.message);
    }
  }
  const m = await api.sendDocument(cfg.DB_CHANNEL_ID, file(), { caption });
  data.meta.msgId = m.message_id;
  try { await api.pinChatMessage(cfg.DB_CHANNEL_ID, m.message_id, { disable_notification: true }); } catch (e) { log('pin failed (give bot pin rights):', e.message); }
  dirty = true;
}

async function flush(force) {
  if (flushing || (!dirty && !force)) return;
  flushing = true; dirty = false;
  try {
    data.meta.savedAt = Date.now();
    const json = JSON.stringify(data);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', json);
    fs.renameSync(FILE + '.tmp', FILE);
    if (cfg.DB_CHANNEL_ID && api) await pushChannel(json);
  } catch (e) { dirty = true; log('flush error:', e.description || e.message); }
  finally { flushing = false; }
}

function ensureUser(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'User';
  const uname = (from.username || '').toLowerCase();
  let u = data.users[from.id];
  if (!u) {
    u = data.users[from.id] = { id: from.id, username: uname, name, joinedAt: Date.now(), premiumUntil: 0, banned: false, adUrl: '', timerMin: 30, day: { d: '', n: 0 }, total: 0 };
    bump('newUsers'); touch();
  } else if (u.username !== uname || u.name !== name) { u.username = uname; u.name = name; touch(); }
  return u;
}
function stub(id) {
  if (!data.users[id])
    data.users[id] = { id, username: '', name: 'User ' + id, joinedAt: Date.now(), premiumUntil: 0, banned: false, adUrl: '', timerMin: 30, day: { d: '', n: 0 }, total: 0, stub: true };
  touch();
  return data.users[id];
}
function bump(key, n = 1) {
  const d = today();
  const o = data.daily[d] || (data.daily[d] = { sent: 0, failed: 0, newUsers: 0 });
  o[key] = (o[key] || 0) + n;
  touch();
}
function prune() {
  const keys = Object.keys(data.daily).sort();
  while (keys.length > 35) delete data.daily[keys.shift()];
}

module.exports = { data, init: (a) => { api = a; }, load, flush, touch, ensureUser, stub, bump, prune };
