// downloads an ad's media (by Bot API file_id) so the userbot can upload it. Small in-memory cache.
const cfg = require('./config');
let api = null, total = 0;
const cache = new Map();
const MAX_CACHE = 40 * 1024 * 1024;

async function load(fileId) {
  if (cache.has(fileId)) return cache.get(fileId);
  const f = await api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error('MEDIA_DOWNLOAD_' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= MAX_CACHE) {
    while (total + buf.length > MAX_CACHE && cache.size) { const k = cache.keys().next().value; total -= cache.get(k).length; cache.delete(k); }
    cache.set(fileId, buf); total += buf.length;
  }
  return buf;
}
module.exports = { init: (a) => { api = a; }, load };
