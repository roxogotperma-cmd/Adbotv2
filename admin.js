const cfg = require('./config');
const db = require('./db');
const plan = require('./plan');
const ui = require('./ui');
const flows = require('./flows');
const notify = require('./notify');
const { esc, fmtDate, sleep, today, log } = require('./util');
const { btn, kb, show, html } = ui;

const { isAdmin, isOwner } = plan;
const back = () => [btn('Back', { cb: 'adm', e: '⬅️' }), btn('Cancel', { cb: 'admx', e: '✖️', st: 'danger' })];

function resolve(arg) {
  arg = String(arg || '').trim();
  if (/^\d{4,15}$/.test(arg)) return Number(arg);
  if (/^@?[A-Za-z0-9_]{4,32}$/.test(arg)) {
    const n = arg.replace('@', '').toLowerCase();
    const u = Object.values(db.data.users).find((x) => x.username === n);
    return u ? u.id : null;
  }
  return null;
}

// ---- actions ----
function grant(uid, key) {
  const u = db.stub(uid), now = Date.now();
  if (key === 'L') u.premiumUntil = -1;
  else if (u.premiumUntil !== -1) u.premiumUntil = (u.premiumUntil > now ? u.premiumUntil : now) + Number(key) * 86400000;
  u.remNotified = false; u.expNotified = false; db.touch();
  notify.main(uid, `🎉 <b>Premium activated!</b>\n👑 ${u.premiumUntil === -1 ? 'Lifetime' : 'Valid till ' + fmtDate(u.premiumUntil)}\n\nCustom timers, ad per account, tag removal &amp; more are now unlocked.`);
  return u;
}
function removePremium(uid) {
  const u = db.stub(uid); u.premiumUntil = 0; db.touch();
  notify.main(uid, '⚠️ Your <b>Premium</b> was removed. You are on the Free plan now.');
}
function ban(uid) {
  const u = db.stub(uid), at = Date.now();
  for (const acc of plan.userAccounts(uid)) { db.data.bannedTg[acc.tgId] = { uid, at }; acc.running = false; delete db.data.accounts[acc.id]; }
  db.data.bannedTg[String(uid)] = { uid, at };
  u.banned = true; db.touch();
  notify.main(uid, '🚫 <b>You were banned from this bot.</b>');
}
function unban(uid) {
  const u = db.stub(uid); u.banned = false;
  for (const k of Object.keys(db.data.bannedTg)) if (db.data.bannedTg[k].uid === uid) delete db.data.bannedTg[k];
  db.touch();
  notify.main(uid, '✅ You were unbanned. Send /start to continue.');
}

function statsText() {
  const us = Object.values(db.data.users), accs = Object.values(db.data.accounts);
  const d = db.data.daily[today()] || { sent: 0, failed: 0, newUsers: 0 };
  const days = Object.keys(db.data.daily).sort().slice(-7).reverse();
  let t = `📊 <b>Bot Stats</b>\n\n👥 Users: <b>${us.length}</b> (new today: ${d.newUsers || 0})\n👑 Premium: <b>${us.filter(plan.isPremium).length}</b>\n🚫 Banned: <b>${us.filter((x) => x.banned).length}</b>\n⚙️ Admins: <b>${db.data.admins.length}</b>\n\n` +
    `📱 Accounts: <b>${accs.length}</b> • running: <b>${accs.filter((a) => a.running).length}</b>\n\n` +
    `📅 <b>Today</b>: ✅ ${d.sent || 0} sent • ❌ ${d.failed || 0} failed\n`;
  if (days.length) t += '\n<b>Last days</b>\n' + days.map((k) => `${k.slice(5)}: ✅ ${db.data.daily[k].sent || 0} / ❌ ${db.data.daily[k].failed || 0}`).join('\n');
  return t;
}

const LIMS = [
  ['freeAccounts', 'Free accounts'], ['premiumAccounts', 'Premium accounts'], ['freeGroups', 'Free groups'],
  ['freeDaily', 'Free daily posts'], ['premiumDaily', 'Premium daily posts'],
];

// ---- screens ----
function panel() {
  const rows = [
    [btn('Stats', { cb: 'adm:stats', e: '📊', st: 'primary' }), btn('Broadcast', { cb: 'adm:bdc', e: '📨', st: 'primary' })],
    [btn('Grant Premium', { cb: 'adm:u:grant', e: '👑', st: 'success' }), btn('Remove Premium', { cb: 'adm:u:rmprem', e: '🚫', st: 'danger' })],
    [btn('Ban', { cb: 'adm:u:ban', e: '🔨', st: 'danger' }), btn('Unban', { cb: 'adm:u:unban', e: '✅', st: 'success' })],
    [btn('User Info', { cb: 'adm:u:info', e: '🔎', st: 'primary' }), btn('Limits', { cb: 'adm:lims', e: '⚙️', st: 'primary' })],
  ];
  return rows;
}
async function showPanel(ctx) {
  flows.clear(ctx.from.id);
  const rows = panel();
  if (isOwner(ctx.from.id)) rows.push([btn('Add Admin', { cb: 'adm:u:addadmin', e: '🛡️', st: 'success' }), btn('Remove Admin', { cb: 'adm:u:rmadmin', e: '🗑️', st: 'danger' })]);
  rows.push([btn('Backup Now', { cb: 'adm:backup', e: '🔄' })], [btn('Back', { cb: 'menu', e: '⬅️' })]);
  return show(ctx, `⚙️ <b>Admin Panel</b>\n\n${isOwner(ctx.from.id) ? '👑 Role: Owner' : '🛡️ Role: Admin'}\n\nCommands:\n<code>/premium id|@user 1|7|30|lifetime</code>\n<code>/remove id|@user</code> • <code>/ban id|@user</code> • <code>/unban</code>\n<code>/bdc</code> • <code>/stats</code> • <code>/info</code> • <code>/emojiid</code>`, kb(rows));
}

const ASK = {
  grant: '👑 <b>Grant Premium</b>\nSend user ID or @username:',
  rmprem: '🚫 <b>Remove Premium</b>\nSend user ID or @username:',
  ban: '🔨 <b>Ban user</b>\nSend user ID or @username:',
  unban: '✅ <b>Unban user</b>\nSend user ID or @username:',
  info: '🔎 <b>User info</b>\nSend user ID or @username:',
  addadmin: '🛡️ <b>Add Admin</b>\nSend user ID or @username:',
  rmadmin: '🗑️ <b>Remove Admin</b>\nSend user ID or @username:',
};

const durRows = (uid) => [
  [btn('1 Day', { cb: `adm:gd:${uid}:1`, st: 'primary' }), btn('7 Days', { cb: `adm:gd:${uid}:7`, st: 'primary' })],
  [btn('30 Days', { cb: `adm:gd:${uid}:30`, st: 'success' }), btn('Lifetime', { cb: `adm:gd:${uid}:L`, e: '👑', st: 'success' })],
  back(),
];

function infoText(uid) {
  const u = db.data.users[uid];
  if (!u) return '⚠️ User not found in DB.';
  const accs = plan.userAccounts(uid);
  return `🔎 <b>User</b> <code>${u.id}</code>\n👤 ${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''}\n📅 Joined: ${fmtDate(u.joinedAt)}\n` +
    `👑 Plan: ${plan.isPremium(u) ? (u.premiumUntil === -1 ? 'Premium (lifetime)' : 'Premium till ' + fmtDate(u.premiumUntil)) : 'Free'}\n🚫 Banned: ${u.banned ? 'yes' : 'no'}\n` +
    `📱 Accounts: ${accs.length} (running ${accs.filter((a) => a.running).length})\n✅ Total posts: ${u.total || 0}`;
}

// ---- broadcast ----
async function runBdc(ctx, ids, chatId, msgId) {
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await ctx.api.copyMessage(id, chatId, msgId); ok++; }
    catch (e) { fail++; if (e.error_code === 403) { const u = db.data.users[id]; if (u) u.blocked = true; } }
    await sleep(45);
  }
  db.touch();
  await html(ctx, `📨 <b>Broadcast done</b>\n✅ Delivered: <b>${ok}</b>\n❌ Failed/blocked: <b>${fail}</b>`, kb([[btn('Admin Panel', { cb: 'adm', e: '⚙️', st: 'primary' })]]));
}
const bdcStart = (ctx) => show(ctx, '📨 <b>Broadcast</b>\n\nWho should receive it?', kb([
  [btn('All Users', { cb: 'adm:bdc:all', e: '👥', st: 'success' }), btn('Targeted', { cb: 'adm:bdc:ids', e: '🎯', st: 'primary' })], back(),
]));

flows.on('adm', async (ctx, f) => {
  const txt = ((ctx.message && ctx.message.text) || '').trim();
  const m = ctx.message;
  if (!isAdmin(ctx.from.id)) return flows.clear(ctx.from.id);

  if (f.step === 'emojiid') {
    const ents = (m.entities || []).filter((e) => e.type === 'custom_emoji');
    if (!ents.length) return html(ctx, '⚠️ Send a message containing premium emoji.');
    const lines = ents.map((e) => `${(m.text || '').substr(e.offset, e.length)} =${e.custom_emoji_id}`);
    flows.clear(ctx.from.id);
    return html(ctx, `<pre>${esc(lines.join('\n'))}</pre>\nPaste these into <code>emoji.js</code>.`);
  }
  if (f.step === 'uid') {
    const uid = resolve(txt);
    if (!uid) return html(ctx, '⚠️ Not found. Send a numeric ID or a known @username.', kb([back()]));
    if (['ban', 'rmprem'].includes(f.act) && (isOwner(uid) || (isAdmin(uid) && !isOwner(ctx.from.id)))) return html(ctx, '⚠️ You cannot do that to an admin/owner.');
    return doAct(ctx, f.act, uid);
  }
  if (f.step === 'lim') {
    const n = Number(txt);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return html(ctx, '⚠️ Send a whole number.', kb([back()]));
    db.data.settings[f.key] = n; db.touch(); flows.clear(ctx.from.id);
    return html(ctx, `✅ Updated. ${esc(f.key)} = <b>${n}</b>`, kb([[btn('Limits', { cb: 'adm:lims', e: '⚙️', st: 'primary' })]]));
  }
  if (f.step === 'bdc_ids') {
    const ids = [...new Set(txt.split(/[\s,]+/).filter((x) => /^\d{4,15}$/.test(x)).map(Number))];
    if (!ids.length) return html(ctx, '⚠️ Send IDs like <code>585884777,88387337,7282828</code>', kb([back()]));
    f.ids = ids; f.step = 'bdc_msg';
    return html(ctx, `🎯 <b>${ids.length}</b> target(s).\n\nNow send the message to broadcast (text, media, formatting — anything).`, kb([back()]));
  }
  if (f.step === 'bdc_msg') {
    f.chatId = ctx.chat.id; f.msgId = m.message_id; f.step = 'bdc_ok';
    const n = f.all ? Object.values(db.data.users).filter((u) => !u.blocked && !u.stub).length : f.ids.length;
    return html(ctx, `📨 Send the message above to <b>${n}</b> user(s)?`, kb([[btn('Send', { cb: 'adm:bdcgo', e: '✅', st: 'success' }), btn('Cancel', { cb: 'admx', e: '✖️', st: 'danger' })]]));
  }
});

async function doAct(ctx, act, uid) {
  const done = (t) => { flows.clear(ctx.from.id); return html(ctx, t, kb([[btn('Admin Panel', { cb: 'adm', e: '⚙️', st: 'primary' })]])); };
  if (act === 'grant') {
    flows.clear(ctx.from.id);
    return html(ctx, `👑 Grant Premium to <code>${uid}</code>\nChoose duration:`, kb(durRows(uid)));
  }
  if (act === 'rmprem') { removePremium(uid); return done(`✅ Premium removed for <code>${uid}</code>`); }
  if (act === 'ban') { ban(uid); return done(`🔨 Banned <code>${uid}</code>. Their accounts were wiped and cannot be re-added by anyone.`); }
  if (act === 'unban') { unban(uid); return done(`✅ Unbanned <code>${uid}</code>`); }
  if (act === 'info') return done(infoText(uid));
  if (act === 'addadmin') {
    if (!isOwner(ctx.from.id)) return done('⚠️ Owner only.');
    if (!db.data.admins.includes(uid)) db.data.admins.push(uid); db.stub(uid);
    notify.main(uid, '🛡️ You are now an <b>admin</b>. Send /admin');
    return done(`✅ <code>${uid}</code> is now admin.`);
  }
  if (act === 'rmadmin') {
    if (!isOwner(ctx.from.id)) return done('⚠️ Owner only.');
    db.data.admins = db.data.admins.filter((x) => x !== uid); db.touch();
    return done(`✅ <code>${uid}</code> is no longer admin.`);
  }
}

function register(bot) {
  const guard = (fn) => async (ctx) => { if (!isAdmin(ctx.from.id)) return; return fn(ctx); };

  bot.command('admin', guard(showPanel));
  bot.command('stats', guard((ctx) => html(ctx, statsText(), kb([[btn('Admin Panel', { cb: 'adm', e: '⚙️', st: 'primary' })]]))));
  bot.command('bdc', guard((ctx) => { flows.clear(ctx.from.id); return bdcStart(ctx); }));
  bot.command('emojiid', guard((ctx) => { flows.set(ctx.from.id, { type: 'adm', step: 'emojiid' }); return html(ctx, '🎯 Send a message with premium emoji — I reply with ready lines for <code>emoji.js</code>.'); }));

  const argCmd = (name, act, ownerOnlyTarget) =>
    bot.command(name, guard(async (ctx) => {
      const parts = (ctx.match || '').trim().split(/\s+/);
      const uid = resolve(parts[0]);
      if (!parts[0] || !uid) return html(ctx, `⚠️ Usage: <code>/${name} id|@username</code>`);
      if (['ban', 'rmprem'].includes(act) && (isOwner(uid) || (isAdmin(uid) && !isOwner(ctx.from.id)))) return html(ctx, '⚠️ You cannot do that to an admin/owner.');
      if (act === 'grant') {
        const d = (parts[1] || '').toLowerCase();
        const key = d === 'lifetime' || d === 'life' || d === 'l' ? 'L' : String(parseInt(d, 10) || '');
        if (!key) return html(ctx, '⚠️ Usage: <code>/premium id|@user 1|7|30|lifetime</code> (any number of days)');
        const u = grant(uid, key);
        return html(ctx, `✅ Premium for <code>${uid}</code>: ${u.premiumUntil === -1 ? 'Lifetime' : 'till ' + fmtDate(u.premiumUntil)}`);
      }
      return doAct(ctx, act, uid);
    }));
  argCmd('premium', 'grant'); argCmd('remove', 'rmprem'); argCmd('ban', 'ban'); argCmd('unban', 'unban');
  argCmd('info', 'info'); argCmd('addadmin', 'addadmin'); argCmd('rmadmin', 'rmadmin');

  bot.callbackQuery(/^adm/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true });
    const [, a, b, c] = ctx.callbackQuery.data.split(':');
    const uid0 = ctx.from.id;
    if (ctx.callbackQuery.data === 'admx') return showPanel(ctx);
    if (!a) return showPanel(ctx);
    switch (a) {
      case 'stats': return show(ctx, statsText(), kb([[btn('Refresh', { cb: 'adm:stats', e: '🔄' }), btn('Back', { cb: 'adm', e: '⬅️' })]]));
      case 'backup': await db.flush(true); return ctx.answerCallbackQuery({ text: '✅ Backup saved to channel', show_alert: true });
      case 'u': {
        if (['addadmin', 'rmadmin'].includes(b) && !isOwner(uid0)) return ctx.answerCallbackQuery({ text: 'Owner only.', show_alert: true });
        flows.set(uid0, { type: 'adm', step: 'uid', act: b });
        return show(ctx, ASK[b], kb([back()]));
      }
      case 'gd': {
        const uid = Number(b);
        if (!uid) return;
        grant(uid, c);
        const u = db.data.users[uid];
        return show(ctx, `✅ Premium for <code>${uid}</code>: ${u.premiumUntil === -1 ? 'Lifetime' : 'till ' + fmtDate(u.premiumUntil)}`, kb([[btn('Admin Panel', { cb: 'adm', e: '⚙️', st: 'primary' })]]));
      }
      case 'lims': {
        const s = plan.settings();
        const rows = LIMS.map(([k, l]) => [btn(`${l}: ${s[k]}`, { cb: 'adm:lim:' + k, st: 'primary' })]);
        rows.push([btn('Reset all to env values', { cb: 'adm:limreset', e: '♻️', st: 'danger' })], [btn('Back', { cb: 'adm', e: '⬅️' })]);
        return show(ctx, '⚙️ <b>Limits</b>\nDefaults come from the env variables. Tap one to override it here.', kb(rows));
      }
      case 'limreset': {
        db.data.settings = {}; db.touch();
        return show(ctx, '✅ All limits reset to the env values.', kb([[btn('Limits', { cb: 'adm:lims', e: '⚙️', st: 'primary' }), btn('Back', { cb: 'adm', e: '⬅️' })]]));
      }
      case 'lim': {
        if (!LIMS.find(([k]) => k === b)) return;
        flows.set(uid0, { type: 'adm', step: 'lim', key: b });
        return show(ctx, `⚙️ Send the new number for <b>${esc(b)}</b> (now ${plan.settings()[b]}):`, kb([back()]));
      }
      case 'bdc': {
        if (b === 'all') { flows.set(uid0, { type: 'adm', step: 'bdc_msg', all: true }); return show(ctx, '👥 <b>All users</b>\n\nSend the message to broadcast (text, media, formatting — anything).', kb([back()])); }
        if (b === 'ids') { flows.set(uid0, { type: 'adm', step: 'bdc_ids' }); return show(ctx, '🎯 <b>Targeted</b>\n\nSend user IDs:\nSingle: <code>988373636</code>\nMultiple: <code>585884777,88387337,7282828</code>', kb([back()])); }
        return bdcStart(ctx);
      }
      case 'bdcgo': {
        const f = flows.get(uid0);
        if (!f || f.step !== 'bdc_ok') return ctx.answerCallbackQuery({ text: 'Expired. Start again with /bdc', show_alert: true });
        const ids = f.all ? Object.values(db.data.users).filter((u) => !u.blocked && !u.stub).map((u) => u.id) : f.ids;
        flows.clear(uid0);
        await show(ctx, `⏳ Sending to <b>${ids.length}</b> user(s)…`);
        runBdc(ctx, ids, f.chatId, f.msgId).catch((e) => log('bdc', e.message));
        return;
      }
    }
  });
}

module.exports = { register, statsText };
