let main = null, upd = null;
const base = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
module.exports = {
  init(m, u) { main = m; upd = u; },
  /** update-bot first, falls back to main bot (if user never started update bot) */
  async update(uid, html, kb, silent = true) {
    const o = { ...base, disable_notification: silent };
    if (kb) o.reply_markup = kb;
    if (upd) { try { await upd.sendMessage(uid, html, o); return true; } catch (e) {} }
    try { await main.sendMessage(uid, html, o); return true; } catch (e) { return false; }
  },
  async main(uid, html, kb) {
    const o = { ...base };
    if (kb) o.reply_markup = kb;
    try { await main.sendMessage(uid, html, o); return true; } catch (e) { return false; }
  },
};
