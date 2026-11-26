const { GrammyError } = require('grammy');
const { sequentialize } = require('@grammyjs/runner');
const E = require('./emoji');
const { sleep } = require('./util');

const flags = { noText: false, noBtn: false };

/** button: label, {cb,url,st:'primary'|'success'|'danger', e:'emoji'} */
function btn(label, o = {}) {
  const b = {};
  const id = o.e ? E.id(o.e) : null;
  if (id && !flags.noBtn) { b.text = label; b.icon_custom_emoji_id = id; }
  else b.text = (o.e ? o.e + ' ' : '') + label;
  if (o.cb) b.callback_data = o.cb;
  if (o.url) b.url = o.url;
  if (o.st && !flags.noBtn) b.style = o.st;
  return b;
}
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });

const stripBtn = (b) => { const { style, icon_custom_emoji_id, ...rest } = b; return rest; };
function prep(payload, noText, noBtn) {
  const p = { ...payload };
  if (typeof p.text === 'string' && p.parse_mode === 'HTML') p.text = noText ? E.strip(p.text) : E.customize(p.text);
  if (noBtn && p.reply_markup && p.reply_markup.inline_keyboard)
    p.reply_markup = { ...p.reply_markup, inline_keyboard: p.reply_markup.inline_keyboard.map((r) => r.map(stripBtn)) };
  return p;
}

/** premium emoji in text + button icons, 429 retry, auto-fallback if custom emoji unsupported */
function installApi(bot) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const isMsg = method === 'sendMessage' || method === 'editMessageText';
    const p = isMsg ? prep(payload, flags.noText, flags.noBtn) : payload;
    for (let i = 0; ; i++) {
      try {
        return await prev(method, p, signal);
      } catch (e) {
        if (e instanceof GrammyError) {
          if (e.error_code === 429 && i < 3) {
            await sleep(((e.parameters && e.parameters.retry_after) || 1) * 1000 + 300);
            continue;
          }
          if (isMsg && e.error_code === 400 && /emoji|entit|style|icon|button/i.test(e.description || '') && !/not modified/i.test(e.description || '')) {
            if (!flags.noText) { try { const r = await prev(method, prep(payload, true, flags.noBtn), signal); flags.noText = true; return r; } catch (e2) {} }
            if (!flags.noBtn) { try { const r = await prev(method, prep(payload, flags.noText, true), signal); flags.noBtn = true; return r; } catch (e2) {} }
            try { const r = await prev(method, prep(payload, true, true), signal); flags.noText = flags.noBtn = true; return r; } catch (e2) {}
          }
        }
        throw e;
      }
    }
  });
}

/** common middleware: per-user ordering, private only, callback auto-answer */
function base(bot) {
  bot.use(sequentialize((ctx) => String((ctx.from && ctx.from.id) || (ctx.chat && ctx.chat.id) || 0)));
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') return;
    if (ctx.callbackQuery) {
      let done = false;
      const orig = ctx.answerCallbackQuery.bind(ctx);
      ctx.answerCallbackQuery = (...a) => { done = true; return orig(...a); };
      try { await next(); } finally { if (!done) orig().catch(() => {}); }
    } else await next();
  });
}

async function show(ctx, text, markup) {
  const extra = { parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try { return await ctx.editMessageText(text, extra); }
    catch (e) { if (/not modified/i.test((e && (e.description || e.message)) || '')) return; }
  }
  return ctx.reply(text, extra);
}
const html = (ctx, text, markup) =>
  ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } });

module.exports = { btn, kb, show, html, installApi, base, flags };
