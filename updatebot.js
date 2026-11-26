const db = require('./db');
const plan = require('./plan');
const ui = require('./ui');
const { esc, dur, today } = require('./util');
const { btn, kb, show } = ui;

function statsText(u) {
  const accs = plan.userAccounts(u.id), L = plan.limits(u);
  const used = plan.dayCount(u);
  let t = `📊 <b>Ad Stats</b>\n\n👤 Plan: ${L.premium ? '👑 Premium' : '🆓 Free'}\n📅 Today: <b>${used}/${L.daily}</b> posts\n✅ Lifetime posts: <b>${u.total || 0}</b>\n`;
  if (!accs.length) return t + '\nNo accounts yet. Add one in the main bot.';
  for (const a of accs.slice(0, 10)) {
    const last = a.stats.last;
    t += `\n📱 <b>${esc(a.phone)}</b> — ${a.dead ? '⚠️ expired' : a.running ? '🟢 running' : '🔴 stopped'}\n` +
      `🔄 Cycles ${a.stats.cycles} • ✅ ${a.stats.sent} • ❌ ${a.stats.failed}\n`;
    if (last) {
      t += `🏁 Last #${last.n}: ✅ ${last.sent} / ❌ ${last.failed} / ⏭️ ${last.skipped} of ${last.total} (${dur(Date.now() - last.startedAt)} ago)\n`;
      if (L.premium && last.failedList && last.failedList.length) t += `❌ ${esc(last.failedList.slice(0, 5).join(', '))}\n`;
    }
    if (a.running && a.nextRunAt > Date.now()) t += `⏳ Next run in ${dur(a.nextRunAt - Date.now())}\n`;
  }
  return t;
}

function register(bot, mainUser) {
  const open = (ctx) => {
    const u = db.data.users[ctx.from.id];
    const mainBtn = btn('Main Bot', { url: `https://t.me/${mainUser}`, e: '🏠', st: 'success' });
    if (!u) return show(ctx, '👋 <b>Ad Update Bot</b>\n\nStart the main bot first to add an account.', kb([[mainBtn]]));
    if (u.banned) return show(ctx, '🚫 <b>You are banned.</b>');
    return show(ctx, statsText(u), kb([[btn('Refresh', { cb: 'r', e: '🔄', st: 'primary' }), mainBtn]]));
  };
  bot.command('start', open);
  bot.command('stats', open);
  bot.callbackQuery('r', open);
  bot.on('message', open);
}
module.exports = { register, statsText };
