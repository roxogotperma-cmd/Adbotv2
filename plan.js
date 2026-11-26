const db = require('./db');
const cfg = require('./config');
const { today } = require('./util');

const isOwner = (id) => id === cfg.OWNER_ID;
const isAdmin = (id) => id === cfg.OWNER_ID || db.data.admins.includes(id);
const isPremium = (u) => !!u && (u.premiumUntil === -1 || u.premiumUntil > Date.now());

const settings = () => ({ ...cfg.LIMITS, ...db.data.settings });

function limits(u) {
  const s = settings();
  const p = isPremium(u);
  return {
    premium: p,
    accounts: p ? s.premiumAccounts : s.freeAccounts,
    groups: p ? Infinity : s.freeGroups,
    daily: p ? s.premiumDaily : s.freeDaily,
    timers: p ? cfg.PREMIUM_TIMERS : cfg.FREE_TIMERS,
  };
}
const userAccounts = (uid) =>
  Object.values(db.data.accounts).filter((a) => a.owner === uid).sort((a, b) => a.createdAt - b.createdAt);

function effTimer(acc, u) {
  const L = limits(u);
  const m = acc.timerMin || 30;
  return L.timers.includes(m) ? m : L.timers.includes(30) ? 30 : L.timers[0];
}
const legacy = (s) => (s ? { kind: 'link', url: s } : null);
/** ad = {kind:'content', text, entities, media} | {kind:'link', url} */
function effAd(acc, u) {
  if (isPremium(u)) { const a = acc.ad || legacy(acc.adUrl); if (a) return a; }
  return u.ad || legacy(u.adUrl) || acc.ad || legacy(acc.adUrl) || null;
}
const wantTag = (acc, u) => !(isPremium(u) && acc.removeTag);
function dayCount(u) {
  const d = today();
  if (!u.day || u.day.d !== d) u.day = { d, n: 0 };
  return u.day.n;
}
const capReached = (u) => dayCount(u) >= limits(u).daily;
function allowedAccount(acc, u) {
  const list = userAccounts(u.id);
  return list.findIndex((a) => a.id === acc.id) < limits(u).accounts;
}
module.exports = { settings, isOwner, isAdmin, isPremium, limits, userAccounts, effTimer, effAd, wantTag, dayCount, capReached, allowedAccount };
