try { require('dotenv').config(); } catch (e) {}
const e = process.env;
const url = (v) => (/^(https?:\/\/|tg:\/\/)/i.test((v || '').trim()) ? v.trim() : '');
let tag = (e.TAG_USERNAME || '').trim();
if (tag && !tag.startsWith('@')) tag = '@' + tag;
const ch = (e.DB_CHANNEL_ID || '').trim();
const int = (v, def, min = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= min ? n : def; };
const list = (v, def) => {
  const a = String(v || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0 && n <= 1440);
  return a.length ? [...new Set(a)].sort((x, y) => x - y) : def;
};

const cfg = {
  BOT_TOKEN: (e.BOT_TOKEN || '').trim(),
  UPDATE_BOT_TOKEN: (e.UPDATE_BOT_TOKEN || '').trim(),
  OWNER_ID: Number(e.OWNER_ID) || 0,
  API_ID: Number(e.API_ID) || 0,
  API_HASH: (e.API_HASH || '').trim(),
  DB_CHANNEL_ID: /^-?\d+$/.test(ch) ? Number(ch) : ch,
  ENC_KEY: e.ENC_KEY || '',
  TAG: tag,
  LINK_1: url(e.LINK_1),
  LINK_2: url(e.LINK_2),
  PORT: Number(e.PORT) || 3000,
  SELF_URL: (e.RENDER_EXTERNAL_URL || e.SELF_URL || '').replace(/\/$/, ''),
  FREE_TIMERS: list(e.FREE_TIMERS, [20, 30, 50]),
  PREMIUM_TIMERS: list(e.PREMIUM_TIMERS, [10, 20, 25, 30, 40, 50, 60]),
  MAX_CONCURRENT: int(e.MAX_CONCURRENT, 3, 1),
  GROUP_DELAY_MS: int(e.GROUP_DELAY_MS, 1500, 0),
  DB_SAVE_SECONDS: int(e.DB_SAVE_SECONDS, 60, 10),
  LIMITS: {
    freeAccounts: int(e.FREE_ACCOUNTS, 2, 0),
    premiumAccounts: int(e.PREMIUM_ACCOUNTS, 6, 1),
    freeGroups: int(e.FREE_GROUPS, 20, 1),
    freeDaily: int(e.FREE_DAILY, 50, 1),
    premiumDaily: int(e.PREMIUM_DAILY, 1000, 1),
  },
};
cfg.missing = () =>
  ['BOT_TOKEN', 'UPDATE_BOT_TOKEN', 'OWNER_ID', 'API_ID', 'API_HASH'].filter((k) => !cfg[k]);
module.exports = cfg;
