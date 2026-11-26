const bigInt = require('big-integer');
const { Api } = require('telegram');
const cfg = require('./config');
const db = require('./db');
const plan = require('./plan');
const ub = require('./userbot');
const notify = require('./notify');
const media = require('./media');
const { dec } = require('./secure');
const { sleep, rand, dur, esc, log, Semaphore, parseAdUrl, timeout } = require('./util');

const MIN = 60e3, HOUR = 3600e3;
const GROUP_DELAY = cfg.GROUP_DELAY_MS; // pause between two groups (ms)
const sem = new Semaphore(cfg.MAX_CONCURRENT);
const busy = new Set();

const label = (acc) => `${esc(acc.phone || 'account')}${acc.tgUsername ? ' (@' + esc(acc.tgUsername) + ')' : ''}`;

function peerOf(t) {
  return t.type === 'c'
    ? new Api.InputPeerChannel({ channelId: bigInt(t.id), accessHash: bigInt(t.ah) })
    : new Api.InputPeerChat({ chatId: bigInt(t.id) });
}
const channelOf = (t) => new Api.InputChannel({ channelId: bigInt(t.id), accessHash: bigInt(t.ah) });

async function refreshTargets(client, acc) {
  const dialogs = await client.getDialogs({ limit: 2000 });
  const old = acc.targets || {};
  const out = {};
  for (const d of dialogs) {
    const e = d.entity;
    if (!e) continue;
    let t = null;
    if (e instanceof Api.Channel) {
      if (!e.megagroup || e.broadcast || e.gigagroup || e.left) continue;
      if (e.bannedRights && e.bannedRights.sendMessages) continue;
      if (e.defaultBannedRights && e.defaultBannedRights.sendMessages && !e.creator && !e.adminRights) continue;
      t = { key: 'c' + e.id, type: 'c', id: String(e.id), ah: String(e.accessHash) };
    } else if (e instanceof Api.Chat) {
      if (e.left || e.deactivated || e.kicked) continue;
      if (e.defaultBannedRights && e.defaultBannedRights.sendMessages && !e.creator && !e.adminRights) continue;
      t = { key: 'g' + e.id, type: 'g', id: String(e.id) };
    } else continue;
    const o = old[t.key] || {};
    out[t.key] = { ...o, ...t, title: e.title || 'group', forum: !!e.forum, nextAt: o.nextAt || 0, mode: o.mode || 'fwd', fails: o.fails || 0 };
  }
  acc.targets = out;
  acc.targetsAt = Date.now();
  db.touch();
}

function activeTargets(acc, L) {
  const now = Date.now();
  const list = Object.values(acc.targets || {}).filter((t) => {
    if (!t.disabled) return true;
    if (now - (t.disabledAt || 0) > 24 * HOUR) { t.disabled = false; t.fails = 0; return true; }
    return false;
  });
  return list.slice(0, L.groups);
}

/** returns after trying one group. mutates cyc/t */
async function sendOne(client, acc, user, t, ad, cyc, timerMs, checks) {
  const now = Date.now();
  const peer = peerOf(t);
  const fail = (reason) => {
    cyc.failed++; acc.stats.failed++; db.bump('failed');
    cyc.errors[reason] = (cyc.errors[reason] || 0) + 1;
    if (cyc.failedList.length < 12) cyc.failedList.push(`${t.title} (${reason})`);
  };

  // auto-detect group timers (slow mode / rules in pinned msg or about)
  if (t.type === 'c' && (!t.metaAt || now - t.metaAt > 6 * HOUR)) {
    try {
      const m = await ub.detectMeta(client, peer, channelOf(t));
      t.slow = m.slow; t.ruleSec = m.rule; t.metaAt = now;
      if (m.nextSend * 1000 > now) { t.nextAt = m.nextSend * 1000 + 1500; cyc.skipped++; return; }
    } catch (e) {
      const c = ub.classify(e);
      if (c.k === 'auth') throw e;
      if (c.k === 'flood') { cyc.floodStop = c.secs; return; }
      t.metaAt = now - 5 * HOUR; // retry later
    }
  }
  const gap = Math.max(timerMs, (t.slow || 0) * 1000 + 3000, (t.ruleSec || 0) * 1000);
  let mode = ad.noFwd ? 'copy' : t.mode || 'fwd';
  let textOnly = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let ids;
      if (mode === 'fwd') {
        const r = await client.forwardMessages(peer, { messages: ad.ids, fromPeer: ad.peer });
        ids = [].concat(r).map((x) => x && x.id).filter(Boolean);
      } else {
        const r = await ub.sendCopy(client, peer, ad, textOnly);
        ids = [].concat(r).map((x) => x && x.id).filter(Boolean);
      }
      t.nextAt = Date.now() + gap; t.fails = 0; t.lastOk = Date.now(); t.mode = ad.noFwd ? t.mode || 'fwd' : mode;
      cyc.sent++; acc.stats.sent++; user.day.n++; user.total = (user.total || 0) + 1; db.bump('sent');
      if (mode === 'fwd') { cyc.fwd++; if (ids.length) checks.push({ t, peer, ids }); } else cyc.copy++;
      return;
    } catch (e) {
      const c = ub.classify(e);
      if (c.k === 'auth') throw e;
      if (c.k === 'slow' || c.k === 'flood') {
        t.nextAt = Date.now() + c.secs * 1000 + 2000;
        if (c.k === 'slow') { t.slow = Math.max(t.slow || 0, c.secs); cyc.skipped++; cyc.errors['slow mode'] = (cyc.errors['slow mode'] || 0) + 1; }
        else { cyc.floodStop = c.secs; cyc.skipped++; }
        return;
      }
      if (c.k === 'fatal') {
        t.disabled = true; t.disabledAt = Date.now(); t.reason = c.reason; cyc.disabled++;
        fail(c.reason); return;
      }
      if (c.k === 'media' && !textOnly) { mode = 'copy'; textOnly = true; continue; }
      if (mode === 'fwd') { mode = 'copy'; t.mode = 'copy'; continue; } // forwarding blocked -> normal post
      t.fails = (t.fails || 0) + 1;
      t.nextAt = Date.now() + timerMs;
      if (t.fails >= 5) { t.disabled = true; t.disabledAt = Date.now(); t.reason = c.reason; cyc.disabled++; }
      fail(c.reason);
      return;
    }
  }
  t.nextAt = Date.now() + timerMs;
  fail('send failed');
}

async function cycle(acc, user) {
  const L = plan.limits(user);
  const def = plan.effAd(acc, user);
  const parsed = def && def.kind === 'link' ? parseAdUrl(def.url) : null;
  if (!def || (def.kind === 'link' && !parsed) || (def.kind === 'content' && !def.text && !def.media)) {
    acc.running = false; db.touch();
    notify.update(user.id, `⚠️ <b>No valid ad set</b>\n👤 ${label(acc)} was stopped. Set an ad and start again.`);
    return;
  }
  let client = null;
  try {
    client = ub.makeClient(dec(acc.session));
    await timeout(client.connect(), 40000, 'CONNECT_TIMEOUT');
    await ub.enforceTag(client, acc, plan.wantTag(acc, user)).catch((e) => { if (ub.isAuthErr(e)) throw e; });
    if (!acc.targetsAt || Date.now() - acc.targetsAt > 30 * MIN) await refreshTargets(client, acc);

    const list = activeTargets(acc, L);
    if (!list.length) {
      acc.nextRunAt = Date.now() + 10 * MIN;
      if (!acc.noGroupsNote) { acc.noGroupsNote = true; notify.update(user.id, `⚠️ ${label(acc)} has no groups where it can post. Join some groups — I'll keep checking.`); }
      return;
    }
    acc.noGroupsNote = false;
    const due = list.filter((t) => t.nextAt <= Date.now());
    if (!due.length) { acc.nextRunAt = Math.max(Date.now() + 10e3, Math.min(...list.map((t) => t.nextAt))); return; }

    let ad;
    try {
      if (def.kind === 'link') ad = await ub.fetchAd(client, parsed);
      else {
        ad = { kind: 'content', def, msgs: [], ids: [], noFwd: true };
        if (def.media) ad.buffer = await media.load(def.media.file_id);
      }
    } catch (e) {
      if (ub.isAuthErr(e)) throw e;
      acc.running = false; db.touch();
      notify.update(user.id, def.kind === 'link'
        ? `⚠️ <b>Ad post not reachable</b>\n👤 ${label(acc)} stopped.\nCheck that <code>${esc(def.url)}</code> is a <b>public</b> post, then set the ad again and resume.`
        : `⚠️ <b>Ad media could not be loaded</b>\n👤 ${label(acc)} stopped.\nSet the ad again and resume.`);
      return;
    }

    const timerMs = plan.effTimer(acc, user) * MIN;
    acc.stats.cycles++;
    const cyc = { n: acc.stats.cycles, startedAt: Date.now(), endedAt: 0, total: due.length, sent: 0, failed: 0, skipped: 0, fwd: 0, copy: 0, disabled: 0, errors: {}, failedList: [], floodStop: 0, capped: false, stopped: false };
    acc.stats.last = cyc; db.touch();
    notify.update(user.id, `🚀 <b>Cycle #${cyc.n} started</b>\n👤 ${label(acc)}\n🎯 Groups this cycle: <b>${due.length}</b>\n⏱️ Timer: <b>${plan.effTimer(acc, user)} min</b>`);

    const checks = [];
    for (const t of due) {
      if (!acc.running) { cyc.stopped = true; break; }
      if (plan.capReached(user)) { cyc.capped = true; break; }
      await sendOne(client, acc, user, t, ad, cyc, timerMs, checks);
      if (cyc.floodStop) break;
      await sleep(GROUP_DELAY);
    }

    // detect "moderation bot deleted my forwarded ad" -> remember + repost as normal message
    if (checks.length && acc.running) {
      await sleep(12000);
      for (const c of checks) {
        try {
          const arr = [].concat(await client.getMessages(c.peer, { ids: c.ids }));
          if (arr.every((m) => !m || m.className === 'MessageEmpty')) {
            c.t.mode = 'copy';
            try { await ub.sendCopy(client, c.peer, ad); cyc.copy++; } catch (e) {}
          }
        } catch (e) {}
        await sleep(600);
      }
    }

    cyc.endedAt = Date.now();
    const act = activeTargets(acc, L);
    acc.nextRunAt = cyc.floodStop
      ? Date.now() + cyc.floodStop * 1000 + 5000
      : act.length ? Math.max(Date.now() + 10e3, Math.min(...act.map((t) => t.nextAt))) : Date.now() + 10 * MIN;
    acc.errs = 0; db.touch();

    const reasons = Object.entries(cyc.errors).map(([k, v]) => `${esc(k)} ×${v}`).join(', ');
    let msg = `🏁 <b>Cycle #${cyc.n} finished</b>\n👤 ${label(acc)}\n✅ Sent: <b>${cyc.sent}</b>  ❌ Failed: <b>${cyc.failed}</b>  ⏭️ Waiting: <b>${cyc.skipped}</b>`;
    msg += `\n🔗 Forwarded: ${cyc.fwd} • 📝 Normal post: ${cyc.copy}`;
    if (cyc.disabled) msg += `\n🚫 Auto-disabled groups: ${cyc.disabled}`;
    if (reasons) msg += `\n⚠️ ${reasons}`;
    if (L.premium && cyc.failedList.length) msg += `\n\n❌ <b>Failed groups:</b>\n` + cyc.failedList.map((x) => '• ' + esc(x)).join('\n');
    if (cyc.capped) msg += `\n\n🛑 Daily limit reached (${L.daily}). Resumes tomorrow (UTC).`;
    if (cyc.floodStop) msg += `\n\n⏳ Telegram flood wait: pausing ${dur(cyc.floodStop * 1000)}.`;
    msg += `\n⏳ Next run: in <b>${dur(Math.max(0, acc.nextRunAt - Date.now()))}</b>`;
    notify.update(user.id, msg);
  } finally {
    if (client) {
      try { await client.disconnect(); } catch (e) {}
      try { await client.destroy(); } catch (e) {}
    }
  }
}

async function runAccount(id) {
  const acc = db.data.accounts[id];
  if (!acc || !acc.running) return;
  const user = db.data.users[acc.owner];
  if (!user || user.banned) { acc.running = false; return; }
  busy.add(id);
  await sem.acquire();
  try {
    if (!db.data.accounts[id] || !acc.running) return;
    await cycle(acc, user);
  } catch (e) {
    if (ub.isAuthErr(e)) {
      acc.dead = true; acc.running = false; db.touch();
      notify.update(user.id, `🚨 <b>Session expired</b>\n👤 ${label(acc)} was logged out. Remove it and add again.`);
    } else {
      acc.errs = (acc.errs || 0) + 1;
      acc.nextRunAt = Date.now() + 3 * MIN;
      log('cycle error', id, ub.errMsg(e));
      if (acc.errs === 5) notify.update(user.id, `⚠️ ${label(acc)}: repeated errors (<code>${esc(ub.errMsg(e).slice(0, 80))}</code>). Still retrying.`);
    }
  } finally {
    sem.release();
    busy.delete(id);
    db.touch();
  }
}

function tick() {
  const now = Date.now();
  for (const acc of Object.values(db.data.accounts)) {
    if (!acc.running || busy.has(acc.id) || (acc.nextRunAt || 0) > now) continue;
    const user = db.data.users[acc.owner];
    if (!user || user.banned) { acc.running = false; continue; }
    if (!plan.allowedAccount(acc, user)) continue;
    if (plan.capReached(user)) { acc.nextRunAt = now + 10 * MIN; continue; }
    runAccount(acc.id).catch((e) => log('run err', e.message));
  }
}

/** keeps the "@tag" on names of accounts that are not running right now */
async function tagLoop() {
  const now = Date.now();
  const list = Object.values(db.data.accounts).filter((a) => !a.running && !busy.has(a.id) && !a.dead && now - (a.tagCheckAt || 0) > 25 * MIN).slice(0, 15);
  for (const acc of list) {
    const user = db.data.users[acc.owner];
    if (!user) continue;
    busy.add(acc.id);
    await sem.acquire();
    let client = null;
    try {
      client = ub.makeClient(dec(acc.session));
      await timeout(client.connect(), 40000, 'CONNECT_TIMEOUT');
      await ub.enforceTag(client, acc, plan.wantTag(acc, user));
    } catch (e) {
      acc.tagCheckAt = Date.now();
      if (ub.isAuthErr(e)) { acc.dead = true; db.touch(); }
    } finally {
      if (client) { try { await client.disconnect(); } catch (e) {} try { await client.destroy(); } catch (e) {} }
      sem.release(); busy.delete(acc.id); db.touch();
    }
  }
}

/** best-effort: remove our tag from the name when an account is removed */
async function cleanupAccount(sessionEnc, acc) {
  let client = null;
  busy.add('x' + acc.id);
  await sem.acquire();
  try {
    client = ub.makeClient(dec(sessionEnc));
    await timeout(client.connect(), 30000, 'CONNECT_TIMEOUT');
    await ub.enforceTag(client, acc, false);
  } catch (e) {}
  finally {
    if (client) { try { await client.disconnect(); } catch (e) {} try { await client.destroy(); } catch (e) {} }
    sem.release(); busy.delete('x' + acc.id);
  }
}

function start() {
  setInterval(tick, 15e3);
  setInterval(() => tagLoop().catch(() => {}), 10 * MIN);
  setTimeout(() => tagLoop().catch(() => {}), 2 * MIN);
}
module.exports = { start, busy, cleanupAccount };
