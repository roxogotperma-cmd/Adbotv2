const crypto = require('crypto');
const { Api } = require('telegram');
const cfg = require('./config');
const db = require('./db');
const plan = require('./plan');
const ui = require('./ui');
const flows = require('./flows');
const ub = require('./userbot');
const adMod = require('./ad');
const sched = require('./scheduler');
const { enc } = require('./secure');
const { esc, dur, fmtDate, timeout, log } = require('./util');
const { btn, kb, show, html } = ui;

let UPD_USER = '';

const cancelRow = () => [btn('Back', { cb: 'menu', e: '⬅️' }), btn('Cancel', { cb: 'cancel', e: '✖️', st: 'danger' })];
const planLine = (u) => plan.isPremium(u)
  ? `👑 <b>Premium</b> (${u.premiumUntil === -1 ? 'Lifetime' : 'till ' + fmtDate(u.premiumUntil)})`
  : '🆓 <b>Free</b>';

function humanErr(e) {
  const m = ub.errMsg(e);
  if (/PHONE_NUMBER_INVALID/.test(m)) return 'Invalid phone number.';
  if (/PHONE_NUMBER_BANNED/.test(m)) return 'This number is banned by Telegram.';
  if (/FLOOD/.test(m)) return `Too many attempts. Wait ${(e && e.seconds) || 'a few'} sec and try again.`;
  if (/PHONE_CODE_INVALID/.test(m)) return 'Wrong code.';
  if (/PHONE_CODE_EXPIRED/.test(m)) return 'Code expired.';
  if (/PASSWORD_HASH_INVALID/.test(m)) return 'Wrong 2FA password.';
  if (/AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(m)) return 'This session is invalid or expired.';
  if (/TIMEOUT/.test(m)) return 'Telegram did not respond in time. Try again.';
  return 'Error: ' + esc(m.slice(0, 90));
}

// ---------- screens ----------
function mainMenu(u) {
  const L = plan.limits(u);
  const accs = plan.userAccounts(u.id);
  const running = accs.filter((a) => a.running).length;
  const text =
    `👋 <b>Welcome, ${esc(u.name)}!</b>\n\n` +
    `🚀 <b>Auto Ad Poster</b>\nAdd your account, set your ad &amp; timer — I post it to all your groups automatically.\n\n` +
    `👤 Plan: ${planLine(u)}\n👥 Accounts: <b>${accs.length}/${L.accounts}</b> • Running: <b>${running}</b>`;
  const rows = [
    [btn('Add Account', { cb: 'add', e: '👤', st: 'success' }), btn('My Accounts', { cb: 'accs', e: '👥', st: 'primary' })],
    [btn('Set Timer', { cb: 'tm', e: '⏱️', st: 'primary' }), btn('Set Ad', { cb: 'ad', e: '📝', st: 'primary' })],
    [btn('Resume All', { cb: 'startall', e: '▶️', st: 'success' }), btn('Stop All', { cb: 'stopall', e: '⏸️', st: 'danger' })],
    [UPD_USER ? btn('Ad Stats', { url: `https://t.me/${UPD_USER}?start=stats`, e: '📊', st: 'primary' }) : btn('Ad Stats', { cb: 'menu', e: '📊' })],
    [cfg.LINK_1 && btn('Official Channel', { url: cfg.LINK_1, e: '📢', st: 'primary' }), cfg.LINK_2 && btn('Deal Safely', { url: cfg.LINK_2, e: '🤝', st: 'success' })].filter(Boolean),
  ];
  if (plan.isAdmin(u.id)) rows.push([btn('Admin Panel', { cb: 'adm', e: '⚙️', st: 'danger' })]);
  return { text, markup: kb(rows) };
}
async function showMenu(ctx) { flows.clear(ctx.from.id); const m = mainMenu(ctx.u); return show(ctx, m.text, m.markup); }

const limitText = (L) => `Account limit reached (${L.accounts}).${L.premium ? '' : ' Upgrade to Premium via Deal Safely.'}`;
async function screenAdd(ctx) {
  const u = ctx.u, L = plan.limits(u);
  if (plan.userAccounts(u.id).length >= L.accounts) return ctx.answerCallbackQuery({ text: limitText(L), show_alert: true });
  const tagNote = cfg.TAG
    ? `\n\n⚠️ <b>Note:</b> ${L.premium ? 'As Premium you can remove' : 'On the Free plan'} the tag <b>${esc(cfg.TAG)}</b> ${L.premium ? 'from the account name.' : 'is added after your account name automatically (re-added if removed).'}`
    : '';
  return show(ctx, `👤 <b>Add Account</b>\n\nChoose how to log in your ad account.\nUse a <b>secondary</b> account, not your main one.${tagNote}`, kb([
    [btn('Phone Login', { cb: 'add:phone', e: '👤', st: 'success' }), btn('Session String', { cb: 'add:sess', e: '🔒', st: 'primary' })],
    cancelRow(),
  ]));
}

async function screenAccounts(ctx) {
  const u = ctx.u, accs = plan.userAccounts(u.id), L = plan.limits(u);
  if (!accs.length) return show(ctx, '👥 <b>My Accounts</b>\n\nNo accounts yet.', kb([[btn('Add Account', { cb: 'add', e: '👤', st: 'success' })], [btn('Back', { cb: 'menu', e: '⬅️' })]]));
  const rows = accs.map((a, i) => [btn(`${a.dead ? '⚠️' : a.running ? '🟢' : '🔴'} ${a.phone || 'account'}${i >= L.accounts ? ' 🔒' : ''}`, { cb: 'acc:' + a.id, st: a.running ? 'success' : 'primary' })]);
  rows.push([btn('Back', { cb: 'menu', e: '⬅️' })]);
  return show(ctx, `👥 <b>My Accounts</b> (${accs.length}/${L.accounts})\n\nTap an account to see details &amp; stats.\n🟢 running • 🔴 stopped`, kb(rows));
}

async function screenAccount(ctx, id) {
  const u = ctx.u, acc = db.data.accounts[id];
  if (!acc || acc.owner !== u.id) return ctx.answerCallbackQuery({ text: 'Account not found.', show_alert: true });
  const L = plan.limits(u);
  const ts = Object.values(acc.targets || {});
  const active = ts.filter((t) => !t.disabled).length;
  const ad = plan.effAd(acc, u);
  const last = acc.stats.last;
  const status = acc.dead ? '⚠️ Session expired' : acc.running ? '🟢 Running' : '🔴 Stopped';
  let t = `📱 <b>${esc(acc.phone || 'Account')}</b>\n\n` +
    `👤 Name: ${esc(acc.baseFirst || '-')}${acc.tgUsername ? ' (@' + esc(acc.tgUsername) + ')' : ''}\n` +
    `⚙️ Status: <b>${status}</b>\n⏱️ Timer: <b>${plan.effTimer(acc, u)} min</b>\n` +
    `📝 Ad: ${ad ? esc(adMod.label(ad)) : '<i>not set</i>'}\n` +
    `👥 Groups: <b>${active}</b> active${ts.length - active ? `, ${ts.length - active} disabled` : ''}${Number.isFinite(L.groups) ? ` (limit ${L.groups})` : ''}\n` +
    `🏷️ Name tag: ${plan.wantTag(acc, u) ? 'On' : 'Off'}\n\n` +
    `📊 <b>Stats</b>\n🔄 Cycles: <b>${acc.stats.cycles}</b>\n✅ Total sent: <b>${acc.stats.sent}</b>\n❌ Total failed: <b>${acc.stats.failed}</b>`;
  if (last) t += `\n\n🏁 <b>Last cycle #${last.n}</b>: ✅ ${last.sent} / ❌ ${last.failed} / ⏭️ ${last.skipped}`;
  if (acc.running && acc.nextRunAt > Date.now()) t += `\n⏳ Next run in <b>${dur(acc.nextRunAt - Date.now())}</b>`;
  const rows = [
    [acc.running ? btn('Stop', { cb: 'ac:stop:' + id, e: '⏸️', st: 'danger' }) : btn('Start', { cb: 'ac:go:' + id, e: '▶️', st: 'success' })],
    [btn('Timer', { cb: 'tm:' + id, e: '⏱️', st: 'primary' }), L.premium ? btn('Ad', { cb: 'ad:' + id, e: '📝', st: 'primary' }) : btn('Ad (Premium)', { cb: 'lock:ad', e: '🔒' })],
    [L.premium ? btn(acc.removeTag ? 'Restore name tag' : 'Remove name tag', { cb: 'ac:tag:' + id, e: '🏷️', st: 'primary' }) : btn('Remove tag (Premium)', { cb: 'lock:tag', e: '🔒' })],
    [btn('Refresh', { cb: 'acc:' + id, e: '🔄' }), btn('Remove', { cb: 'ac:rm:' + id, e: '🗑️', st: 'danger' })],
    [btn('Back', { cb: 'accs', e: '⬅️' })],
  ];
  return show(ctx, t, kb(rows));
}

async function screenTimerPick(ctx) {
  const u = ctx.u, accs = plan.userAccounts(u.id);
  if (!accs.length) return ctx.answerCallbackQuery({ text: 'Add an account first.', show_alert: true });
  if (!plan.isPremium(u) || accs.length === 1) return screenSlots(ctx, 'all');
  const rows = [[btn('All accounts', { cb: 'tm:all', e: '👥', st: 'success' })]];
  accs.forEach((a) => rows.push([btn(`${a.phone} • ${plan.effTimer(a, u)} min`, { cb: 'tm:' + a.id, st: 'primary' })]));
  rows.push(cancelRow());
  return show(ctx, '⏱️ <b>Set Timer</b>\n\nPick an account (or all):', kb(rows));
}
async function screenSlots(ctx, target) {
  const u = ctx.u, L = plan.limits(u);
  let cur = null;
  if (target !== 'all') { const a = db.data.accounts[target]; if (!a || a.owner !== u.id) return ctx.answerCallbackQuery({ text: 'Account not found.', show_alert: true }); cur = plan.effTimer(a, u); }
  const btns = L.timers.map((m) => btn(`${m} min`, { cb: `tv:${target}:${m}`, st: m === cur ? 'success' : 'primary' }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  rows.push([btn('Back', { cb: target === 'all' ? 'menu' : 'acc:' + target, e: '⬅️' }), btn('Cancel', { cb: 'cancel', e: '✖️', st: 'danger' })]);
  return show(ctx, `⏱️ <b>Set Timer</b>\n\nDelay between ads <b>per group</b>.\n${L.premium ? '👑 Premium slots' : '🆓 Free slots (Premium gets 10–60 min options)'}${cur ? `\nCurrent: <b>${cur} min</b>` : ''}`, kb(rows));
}

async function screenAdPick(ctx) {
  const u = ctx.u, accs = plan.userAccounts(u.id);
  if (!plan.isPremium(u) || accs.length <= 1) return promptAd(ctx, 'all');
  const rows = [[btn('Same ad for all accounts', { cb: 'ad:all', e: '👥', st: 'success' })]];
  accs.forEach((a) => rows.push([btn(`${a.phone}${a.ad || a.adUrl ? ' ✅' : ''}`, { cb: 'ad:' + a.id, st: 'primary' })]));
  rows.push(cancelRow());
  return show(ctx, '📝 <b>Set Ad</b>\n\n👑 Premium: different ad for each account.\nPick where to apply:', kb(rows));
}
async function promptAd(ctx, target) {
  const u = ctx.u;
  if (target !== 'all') { const a = db.data.accounts[target]; if (!a || a.owner !== u.id) return ctx.answerCallbackQuery({ text: 'Account not found.', show_alert: true }); }
  flows.set(u.id, { type: 'ad', target });
  return show(ctx,
    '📝 <b>Set Ad</b>\n\n<b>What text would you like to advertise?</b>\nSend it now — I will post exactly this.\n\n' +
    '✨ Bold / italic / links / premium emoji are kept.\n🖼 You can also send a photo, video, GIF or file with a caption.',
    kb([cancelRow()]));
}

// ---------- add account ----------
async function askPhone(ctx) {
  flows.set(ctx.from.id, { type: 'add', step: 'phone' });
  return show(ctx, '📱 <b>Phone Login</b>\n\nSend the phone number with country code:\n<code>+919999999999</code>', kb([cancelRow()]));
}
async function askSession(ctx) {
  flows.set(ctx.from.id, { type: 'add', step: 'sess' });
  return show(ctx, '🔒 <b>Session String</b>\n\nPaste your <b>GramJS / Telethon string session</b>.\nThe message is deleted right after I read it.', kb([cancelRow()]));
}

async function finishAdd(ctx, u, client, phoneHint) {
  const done = async (text, markup) => { flows.clear(u.id); try { await client.disconnect(); } catch (e) {} try { await client.destroy(); } catch (e) {} return html(ctx, text, markup); };
  let me;
  try { me = await timeout(client.getMe(), 25000); } catch (e) { return done('⚠️ ' + humanErr(e), kb([[btn('Try again', { cb: 'add', e: '🔄', st: 'primary' })]])); }
  const tgId = String(me.id);
  if (db.data.bannedTg[tgId])
    return done('🚫 <b>Banned account!</b>\n\nThis Telegram account is banned from using this bot.\nPlease add a <b>different</b> account.', kb([[btn('Add Other', { cb: 'add', e: '👤', st: 'success' })], [btn('Back', { cb: 'menu', e: '⬅️' })]]));
  const exist = Object.values(db.data.accounts).find((a) => a.tgId === tgId);
  if (exist && exist.owner !== u.id)
    return done('⚠️ This account is already added by another user.', kb([[btn('Add Other', { cb: 'add', e: '👤', st: 'success' })], [btn('Back', { cb: 'menu', e: '⬅️' })]]));
  const L = plan.limits(u);
  if (!exist && plan.userAccounts(u.id).length >= L.accounts)
    return done(`⚠️ Account limit reached (${L.accounts}).`, kb([[btn('Back', { cb: 'menu', e: '⬅️' })]]));
  const session = client.session.save();
  const acc = exist || {
    id: 'a' + crypto.randomBytes(5).toString('hex'), owner: u.id, createdAt: Date.now(), ad: null, timerMin: u.timerMin || 30,
    running: false, removeTag: false, targets: {}, stats: { cycles: 0, sent: 0, failed: 0, last: null },
  };
  acc.session = enc(session);
  acc.dead = false;
  acc.tgId = tgId;
  acc.phone = me.phone ? '+' + me.phone : phoneHint || acc.phone || 'account';
  acc.baseFirst = acc.baseFirst || me.firstName || 'User';
  acc.tgUsername = me.username || '';
  db.data.accounts[acc.id] = acc;
  try { await ub.enforceTag(client, acc, plan.wantTag(acc, u)); } catch (e) { log('tag on add:', ub.errMsg(e)); }
  db.touch();
  return done(
    `✅ <b>Account added!</b>\n\n📱 <b>${esc(acc.phone)}</b>\n\nNext: set your ad and start posting.${cfg.TAG && plan.wantTag(acc, u) ? `\n🏷️ Name tag <b>${esc(cfg.TAG)}</b> was added to the account name.` : ''}`,
    kb([[btn('Set Ad', { cb: 'ad', e: '📝', st: 'primary' }), btn('My Accounts', { cb: 'accs', e: '👥', st: 'success' })], [btn('Back', { cb: 'menu', e: '⬅️' })]]));
}

flows.on('add', async (ctx, f) => {
  const u = ctx.u;
  const txt = ((ctx.message && ctx.message.text) || '').trim();
  if (!txt) return;
  ctx.deleteMessage().catch(() => {});
  const retry = kb([cancelRow()]);

  if (f.step === 'phone') {
    let phone = txt.replace(/[^\d+]/g, '');
    if (!phone.startsWith('+')) phone = '+' + phone;
    if (!/^\+\d{8,15}$/.test(phone)) return html(ctx, '⚠️ Invalid number. Send like <code>+919999999999</code>', retry);
    const wait = await html(ctx, '⏳ Sending login code…');
    let client = null;
    try {
      client = ub.makeClient('');
      await timeout(client.connect(), 30000, 'CONNECT_TIMEOUT');
      const r = await timeout(client.sendCode({ apiId: cfg.API_ID, apiHash: cfg.API_HASH }, phone), 30000, 'CODE_TIMEOUT');
      f.client = client; f.phone = phone; f.hash = r.phoneCodeHash; f.step = 'code';
      ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      return html(ctx, `📨 <b>Code sent to ${esc(phone)}</b>\n\nCheck your Telegram app and send the code with <b>spaces or dashes</b>, like <code>1 2 3 4 5</code>\n(Plain digits can make Telegram block the login.)`, retry);
    } catch (e) {
      if (client) { try { await client.disconnect(); await client.destroy(); } catch (e2) {} }
      return html(ctx, '⚠️ ' + humanErr(e), retry);
    }
  }

  if (f.step === 'code') {
    const code = txt.replace(/\D/g, '');
    if (code.length < 4) return html(ctx, '⚠️ Send the code like <code>1 2 3 4 5</code>', retry);
    try {
      const r = await timeout(f.client.invoke(new Api.auth.SignIn({ phoneNumber: f.phone, phoneCodeHash: f.hash, phoneCode: code })), 30000, 'SIGNIN_TIMEOUT');
      if (r && r.className === 'auth.AuthorizationSignUpRequired') { flows.clear(u.id); return html(ctx, '⚠️ This number is not registered on Telegram.', kb([[btn('Back', { cb: 'menu', e: '⬅️' })]])); }
    } catch (e) {
      const m = ub.errMsg(e);
      if (m === 'SESSION_PASSWORD_NEEDED') { f.step = 'pass'; return html(ctx, '🔒 <b>2FA enabled</b>\n\nSend your Telegram 2-step password (message is deleted after reading).', retry); }
      if (/PHONE_CODE_EXPIRED/.test(m)) { flows.clear(u.id); return html(ctx, '⚠️ Code expired. Start again.', kb([[btn('Try again', { cb: 'add', e: '🔄', st: 'primary' })]])); }
      return html(ctx, '⚠️ ' + humanErr(e) + '\nSend the code again.', retry);
    }
    return finishAdd(ctx, u, f.client, f.phone);
  }

  if (f.step === 'pass') {
    try {
      let computeCheck = null;
      try { computeCheck = require('telegram/Password').computeCheck; } catch (e) {}
      if (computeCheck) {
        const p = await timeout(f.client.invoke(new Api.account.GetPassword()), 25000);
        const c = await computeCheck(p, txt);
        await timeout(f.client.invoke(new Api.auth.CheckPassword({ password: c })), 25000);
      } else {
        let last = null;
        try { await f.client.signInWithPassword({ apiId: cfg.API_ID, apiHash: cfg.API_HASH }, { password: async () => txt, onError: async (er) => { last = er; return true; } }); }
        catch (er) { throw last || er; }
      }
    } catch (e) { return html(ctx, '⚠️ ' + humanErr(e) + '\nSend the password again.', retry); }
    return finishAdd(ctx, u, f.client, f.phone);
  }

  if (f.step === 'sess') {
    const wait = await html(ctx, '⏳ Checking session…');
    let client = null;
    try {
      client = ub.makeClient(txt.replace(/\s+/g, ''));
      await timeout(client.connect(), 30000, 'CONNECT_TIMEOUT');
      await timeout(client.getMe(), 25000, 'ME_TIMEOUT');
      f.client = client;
      ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    } catch (e) {
      if (client) { try { await client.disconnect(); await client.destroy(); } catch (e2) {} }
      return html(ctx, '⚠️ Invalid session string. ' + humanErr(e), retry);
    }
    return finishAdd(ctx, u, f.client, '');
  }
});

flows.on('ad', async (ctx, f) => {
  const u = ctx.u;
  const def = adMod.fromMessage(ctx.message);
  if (def.error) return html(ctx, '⚠️ ' + esc(def.error), kb([cancelRow()]));
  if (f.target === 'all') { u.ad = def; u.adUrl = ''; plan.userAccounts(u.id).forEach((a) => { a.ad = null; a.adUrl = ''; }); }
  else { const a = db.data.accounts[f.target]; if (a && a.owner === u.id) { a.ad = def; a.adUrl = ''; } }
  db.touch();
  flows.clear(u.id);
  if (def.kind === 'content') ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id).catch(() => {}); // preview
  return html(ctx, `✅ <b>Ad saved</b>\n${esc(adMod.label(def))}\n${def.kind === 'content' ? '⬆️ This is how it will be posted.\n' : ''}\nUse ▶️ Start on an account (or Resume All) to begin posting.`,
    kb([[btn('Resume All', { cb: 'startall', e: '▶️', st: 'success' }), btn('My Accounts', { cb: 'accs', e: '👥', st: 'primary' })], [btn('Back', { cb: 'menu', e: '⬅️' })]]));
});

// ---------- actions ----------
function startAcc(acc, u) {
  if (acc.dead) return 'Session expired — remove & add again.';
  if (!plan.allowedAccount(acc, u)) return 'Over your plan limit.';
  if (!plan.effAd(acc, u)) return 'Set an ad first.';
  acc.running = true; acc.nextRunAt = 0; db.touch();
  return null;
}

function setup(bot, updUser) {
  UPD_USER = updUser || '';
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    ctx.u = db.ensureUser(ctx.from);
    if (ctx.u.banned && !plan.isAdmin(ctx.from.id)) {
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: '🚫 You are banned from this bot.', show_alert: true });
      return html(ctx, '🚫 <b>You are banned from using this bot.</b>');
    }
    return next();
  });
}

function register(bot) {
  bot.command('start', showMenu);
  bot.command('menu', showMenu);

  bot.on('callback_query:data', async (ctx) => {
    const u = ctx.u;
    const [a, b, c] = ctx.callbackQuery.data.split(':');
    switch (a) {
      case 'menu': return showMenu(ctx);
      case 'cancel': return showMenu(ctx);
      case 'add':
        if (b === 'phone') return askPhone(ctx);
        if (b === 'sess') return askSession(ctx);
        return screenAdd(ctx);
      case 'accs': flows.clear(u.id); return screenAccounts(ctx);
      case 'acc': return screenAccount(ctx, b);
      case 'lock': return ctx.answerCallbackQuery({ text: '👑 Premium feature. Get Premium via Deal Safely.', show_alert: true });
      case 'tm': return b ? screenSlots(ctx, b) : screenTimerPick(ctx);
      case 'tv': {
        const m = Number(c);
        if (!plan.limits(u).timers.includes(m)) return ctx.answerCallbackQuery({ text: '👑 This timer is Premium only.', show_alert: true });
        if (b === 'all') { u.timerMin = m; plan.userAccounts(u.id).forEach((x) => { x.timerMin = m; }); }
        else { const x = db.data.accounts[b]; if (!x || x.owner !== u.id) return ctx.answerCallbackQuery({ text: 'Not found.', show_alert: true }); x.timerMin = m; }
        db.touch();
        await ctx.answerCallbackQuery({ text: `✅ Timer set: ${m} min` });
        return b === 'all' ? showMenu(ctx) : screenAccount(ctx, b);
      }
      case 'ad': return b ? promptAd(ctx, b) : screenAdPick(ctx);
      case 'startall': {
        const accs = plan.userAccounts(u.id);
        if (!accs.length) return ctx.answerCallbackQuery({ text: 'Add an account first.', show_alert: true });
        let n = 0, err = '';
        for (const x of accs) { const r = startAcc(x, u); if (r) err = r; else n++; }
        if (!n) return ctx.answerCallbackQuery({ text: '⚠️ ' + err, show_alert: true });
        await ctx.answerCallbackQuery({ text: `▶️ Started ${n} account(s)` });
        return showMenu(ctx);
      }
      case 'stopall': {
        plan.userAccounts(u.id).forEach((x) => { x.running = false; }); db.touch();
        await ctx.answerCallbackQuery({ text: '⏸️ All accounts stopped' });
        return showMenu(ctx);
      }
      case 'ac': {
        const acc = db.data.accounts[c];
        if (!acc || acc.owner !== u.id) return ctx.answerCallbackQuery({ text: 'Account not found.', show_alert: true });
        if (b === 'go') { const r = startAcc(acc, u); if (r) return ctx.answerCallbackQuery({ text: '⚠️ ' + r, show_alert: true }); await ctx.answerCallbackQuery({ text: '▶️ Started' }); }
        else if (b === 'stop') { acc.running = false; db.touch(); await ctx.answerCallbackQuery({ text: '⏸️ Stopped' }); }
        else if (b === 'tag') {
          if (!plan.isPremium(u)) return ctx.answerCallbackQuery({ text: '👑 Premium feature.', show_alert: true });
          acc.removeTag = !acc.removeTag; acc.tagCheckAt = 0; db.touch();
          await ctx.answerCallbackQuery({ text: acc.removeTag ? '🏷️ Tag will be removed shortly' : '🏷️ Tag will be restored shortly' });
        } else if (b === 'rm') {
          return show(ctx, `🗑️ <b>Remove ${esc(acc.phone)}?</b>\n\nThe session, stats and all data of this account will be deleted from the bot.`, kb([
            [btn('Yes, remove', { cb: 'ac:rmy:' + c, e: '✅', st: 'danger' }), btn('Cancel', { cb: 'acc:' + c, e: '✖️', st: 'primary' })],
          ]));
        } else if (b === 'rmy') {
          const copy = { ...acc }; const sess = acc.session;
          acc.running = false; delete db.data.accounts[c]; db.touch();
          sched.cleanupAccount(sess, copy).catch(() => {});
          await ctx.answerCallbackQuery({ text: '🗑️ Account removed' });
          return screenAccounts(ctx);
        }
        return screenAccount(ctx, c);
      }
    }
  });

  bot.on('message', async (ctx) => {
    if (await flows.handle(ctx)) return;
    const t = ((ctx.message && ctx.message.text) || '').trim();
    if (t.startsWith('/')) return;
    const u = ctx.u, L = plan.limits(u);
    const digits = t.replace(/\D/g, '');
    const looksPhone = /^\+?[\d\s\-().]+$/.test(t) && digits.length >= 8 && digits.length <= 15;
    const looksSession = /^[A-Za-z0-9+/=_-]{200,}$/.test(t);
    if (looksPhone || looksSession) {   // flow was lost (restart / sleep): start login from the message itself
      if (plan.userAccounts(u.id).length >= L.accounts) return html(ctx, '⚠️ ' + limitText(L), kb([[btn('Back', { cb: 'menu', e: '⬅️' })]]));
      flows.set(u.id, { type: 'add', step: looksPhone ? 'phone' : 'sess' });
      return flows.handle(ctx);
    }
    if (/^[\d\s-]{4,8}$/.test(t)) return html(ctx, '⚠️ Login session expired. Tap <b>Add Account</b> and start again.', kb([[btn('Add Account', { cb: 'add', e: '👤', st: 'success' })]]));
    return html(ctx, 'ℹ️ Send /start to open the menu.');   // panel only on /start
  });
}

module.exports = { setup, register, mainMenu };
