const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const today = () => new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString(), ...a);

function dur(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  let m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  m = m % 60;
  if (h < 48) return h + 'h ' + m + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
const fmtDate = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function parseAdUrl(u) {
  const m = String(u || '').trim().match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})\/(?:\d+\/)?(\d+)\/?(?:\?.*)?$/);
  if (!m || m[1].toLowerCase() === 'c' || m[1].toLowerCase() === 's') return null;
  return { username: m[1], id: Number(m[2]) };
}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() {
    if (this.n > 0) { this.n--; return; }
    await new Promise((r) => this.q.push(r));
  }
  release() {
    const r = this.q.shift();
    if (r) r(); else this.n++;
  }
}
const timeout = (p, ms, label = 'TIMEOUT') =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))]);

module.exports = { esc, sleep, rand, today, log, dur, fmtDate, parseAdUrl, Semaphore, timeout };
