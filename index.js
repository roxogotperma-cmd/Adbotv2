const http = require('http');
const { Bot } = require('grammy');
const { run } = require('@grammyjs/runner');
const cfg = require('./config');
const db = require('./db');
const ui = require('./ui');
const flows = require('./flows');
const notify = require('./notify');
const plan = require('./plan');
const sched = require('./scheduler');
const botMod = require('./bot');
const admin = require('./admin');
const updMod = require('./updatebot');
const media = require('./media');
const { log, sleep } = require('./util');

const miss = cfg.missing();
if (miss.length) { console.error('Missing env vars: ' + miss.join(', ')); process.exit(1); }
if (!cfg.DB_CHANNEL_ID) log('WARNING: DB_CHANNEL_ID not set — data only stored on local disk (lost on Render redeploy!)');
if (!cfg.ENC_KEY) log('WARNING: ENC_KEY not set — sessions encrypted with a key derived from BOT_TOKEN');

process.on('unhandledRejection', (e) => log('unhandledRejection', (e && e.message) || e));
process.on('uncaughtException', (e) => log('uncaughtException', (e && e.stack) || e));

const handles = [];
let stopping = false;
function poll(bot, name) {
  (async () => {
    while (!stopping) {
      try {
        const h = run(bot, { runner: { fetch: { allowed_updates: ['message', 'callback_query'] } } });
        handles.push(h);
        await h.task();
      } catch (e) {
        log(name, 'polling error:', e.message);
        if (/409|Conflict/i.test(e.message || '')) log('!!! ' + name + ': ANOTHER copy of this bot is running (old deploy / your PC). Stop it, or users will see random resets.');
      }
      if (!stopping) await sleep(5000);
    }
  })();
}

async function main() {
  const bot = new Bot(cfg.BOT_TOKEN);
  const upd = new Bot(cfg.UPDATE_BOT_TOKEN);
  ui.installApi(bot); ui.installApi(upd);
  bot.catch((e) => log('main bot err:', e.message));
  upd.catch((e) => log('update bot err:', e.message));
  await bot.init(); await upd.init();

  db.init(bot.api);
  media.init(bot.api);
  await db.load();
  notify.init(bot.api, upd.api);

  ui.base(bot); ui.base(upd);
  botMod.setup(bot, upd.botInfo.username);
  admin.register(bot);
  botMod.register(bot);
  updMod.register(upd, bot.botInfo.username);

  // health server (Render web service) + self ping
  http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }).listen(cfg.PORT, () => log('HTTP on', cfg.PORT));
  if (cfg.SELF_URL) setInterval(() => fetch(cfg.SELF_URL + '/health').catch(() => {}), 4 * 60e3);

  // background jobs
  setInterval(() => db.flush(), cfg.DB_SAVE_SECONDS * 1000);
  setInterval(() => flows.sweep(), 60e3);
  setInterval(() => {
    const now = Date.now();
    for (const u of Object.values(db.data.users)) {
      if (!u.premiumUntil || u.premiumUntil === -1) continue;
      if (u.premiumUntil < now && !u.expNotified) { u.expNotified = true; db.touch(); notify.main(u.id, '⚠️ Your <b>Premium expired</b>. You are on the Free plan now. Renew via Deal Safely.'); }
      else if (u.premiumUntil > now && u.premiumUntil - now < 86400e3 && !u.remNotified) { u.remNotified = true; db.touch(); notify.main(u.id, '⏳ Your <b>Premium expires within 24 hours</b>. Renew to keep your features.'); }
    }
    db.prune();
  }, 3600e3);

  await bot.api.deleteWebhook().catch(() => {});
  await upd.api.deleteWebhook().catch(() => {});
  sched.start();
  poll(bot, 'main'); poll(upd, 'update');
  log(`Started: @${bot.botInfo.username} + @${upd.botInfo.username}`);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('Shutting down…');
    setTimeout(() => process.exit(0), 9000).unref();
    for (const h of handles) { try { h.stop(); } catch (e) {} }
    await db.flush(true);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
