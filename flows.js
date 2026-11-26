// per-user conversation state (in memory, auto-expiring)
const map = new Map();
const handlers = {};
const kill = (f) => {
  if (f && f.client) {
    try { Promise.resolve(f.client.disconnect()).catch(() => {}); } catch (e) {}
    try { Promise.resolve(f.client.destroy()).catch(() => {}); } catch (e) {}
  }
};
module.exports = {
  set(uid, f) { const old = map.get(uid); if (old && old.client && old.client !== f.client) kill(old); f.ts = Date.now(); map.set(uid, f); return f; },
  get: (uid) => map.get(uid),
  drop: (uid) => map.delete(uid), // keep client alive
  clear(uid) { kill(map.get(uid)); map.delete(uid); },
  on(type, fn) { handlers[type] = fn; },
  async handle(ctx) {
    const f = map.get(ctx.from.id);
    if (!f || !handlers[f.type]) return false;
    f.ts = Date.now();
    await handlers[f.type](ctx, f);
    return true;
  },
  sweep() {
    const now = Date.now();
    for (const [k, f] of map) if (now - f.ts > 15 * 60e3) { kill(f); map.delete(k); }
  },
};
