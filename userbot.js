const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');
const cfg = require('./config');

function makeClient(session) {
  const c = new TelegramClient(new StringSession(session || ''), cfg.API_ID, cfg.API_HASH, {
    connectionRetries: 3,
    retryDelay: 1500,
    autoReconnect: false,
    floodSleepThreshold: 0,
    useWSS: false,
    deviceModel: 'Desktop',
    appVersion: '1.0',
  });
  try { c.setLogLevel('none'); } catch (e) {}
  return c;
}

const errMsg = (e) => String((e && (e.errorMessage || e.message)) || e || '');
const isAuthErr = (e) => /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED/i.test(errMsg(e));

function classify(e) {
  const m = errMsg(e);
  const num = (e && e.seconds) || parseInt((m.match(/(\d+)/) || [])[1], 10) || 60;
  if (isAuthErr(e)) return { k: 'auth', reason: 'session expired' };
  if (/SLOWMODE_WAIT/i.test(m)) return { k: 'slow', secs: num, reason: 'slow mode' };
  if (/FLOOD/i.test(m) && !/FLOOD_TEST/.test(m)) return { k: 'flood', secs: num, reason: 'flood wait' };
  if (/SEND_MEDIA_FORBIDDEN|SEND_PHOTOS_FORBIDDEN|SEND_VIDEOS_FORBIDDEN|SEND_DOCS_FORBIDDEN|SEND_STICKERS_FORBIDDEN|SEND_GIFS_FORBIDDEN|SEND_ROUNDVIDEOS_FORBIDDEN|SEND_VOICES_FORBIDDEN|SEND_AUDIOS_FORBIDDEN/i.test(m)) return { k: 'media', reason: 'media not allowed' };
  if (/USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ID_INVALID|PEER_ID_INVALID|USER_KICKED|CHAT_SEND_PLAIN_FORBIDDEN|CHAT_GUEST_SEND_FORBIDDEN|USER_NOT_PARTICIPANT|TOPIC_CLOSED|CHAT_ADMIN_REQUIRED|CHAT_RESTRICTED/i.test(m))
    return { k: 'fatal', reason: m.replace(/_/g, ' ').toLowerCase().slice(0, 40) };
  return { k: 'other', reason: m.replace(/_/g, ' ').toLowerCase().slice(0, 40) || 'error' };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** keeps "@tag" after the account's first name (or removes it) */
async function enforceTag(client, acc, want) {
  const me = await client.getMe();
  acc.tgUsername = me.username || '';
  acc.tagCheckAt = Date.now();
  const tag = cfg.TAG;
  if (!tag) return;
  const re = new RegExp('\\s*' + escRe(tag), 'ig');
  const first = me.firstName || '';
  const last = me.lastName || '';
  const has = (first + ' ' + last).toLowerCase().includes(tag.toLowerCase());
  if (want && !has) {
    const base = first.replace(re, '').trim() || acc.baseFirst || 'User';
    acc.baseFirst = base;
    const nf = (base.slice(0, Math.max(1, 64 - tag.length - 1)) + ' ' + tag).trim();
    await client.invoke(new Api.account.UpdateProfile({ firstName: nf, lastName: last }));
  } else if (!want && has) {
    const nf = first.replace(re, '').trim() || acc.baseFirst || 'User';
    const nl = last.replace(re, '').trim();
    await client.invoke(new Api.account.UpdateProfile({ firstName: nf, lastName: nl }));
  }
}

/** fetch the public ad post (+album siblings) */
async function fetchAd(client, parsed) {
  const entity = await client.getEntity(parsed.username);
  const peer = await client.getInputEntity(entity);
  const one = [].concat(await client.getMessages(entity, { ids: parsed.id }));
  const m = one[0];
  if (!m || m.className === 'MessageEmpty') throw new Error('AD_NOT_FOUND');
  let msgs = [m];
  if (m.groupedId) {
    const ids = [];
    for (let i = parsed.id - 9; i <= parsed.id + 9; i++) if (i > 0) ids.push(i);
    const arr = [].concat(await client.getMessages(entity, { ids }));
    msgs = arr.filter((x) => x && x.groupedId && String(x.groupedId) === String(m.groupedId)).sort((a, b) => a.id - b.id);
    if (!msgs.length) msgs = [m];
  }
  return { peer, msgs, ids: msgs.map((x) => x.id), noFwd: !!(m.noforwards || entity.noforwards) };
}

const isFileMedia = (media) =>
  media && !(media instanceof Api.MessageMediaWebPage) && !(media instanceof Api.MessageMediaEmpty) &&
  !(media instanceof Api.MessageMediaPoll) && !(media instanceof Api.MessageMediaGeo) && !(media instanceof Api.MessageMediaContact);

/** Bot-API entities (stored with the ad) -> GramJS entities. Keeps bold/italic/links/premium emoji etc. */
function toGramEntities(list) {
  const out = [];
  for (const e of list || []) {
    const b = { offset: e.offset, length: e.length };
    switch (e.type) {
      case 'bold': out.push(new Api.MessageEntityBold(b)); break;
      case 'italic': out.push(new Api.MessageEntityItalic(b)); break;
      case 'underline': out.push(new Api.MessageEntityUnderline(b)); break;
      case 'strikethrough': out.push(new Api.MessageEntityStrike(b)); break;
      case 'code': out.push(new Api.MessageEntityCode(b)); break;
      case 'pre': out.push(new Api.MessageEntityPre({ ...b, language: e.language || '' })); break;
      case 'text_link': out.push(new Api.MessageEntityTextUrl({ ...b, url: e.url })); break;
      case 'spoiler': out.push(new Api.MessageEntitySpoiler(b)); break;
      case 'blockquote': out.push(new Api.MessageEntityBlockquote(b)); break;
      case 'expandable_blockquote': out.push(new Api.MessageEntityBlockquote({ ...b, collapsed: true })); break;
      case 'custom_emoji': out.push(new Api.MessageEntityCustomEmoji({ ...b, documentId: bigInt(String(e.custom_emoji_id)) })); break;
      default: break;
    }
  }
  return out;
}

/** the ad the user typed/sent directly (text or media + caption). First send uploads, the rest reuse the uploaded media. */
async function sendContent(client, peer, ad, textOnly) {
  const d = ad.def;
  const ents = toGramEntities(d.entities);
  if (!textOnly && d.media) {
    if (ad.cache) return await client.sendFile(peer, { file: ad.cache, caption: d.text || '', formattingEntities: ents });
    const { CustomFile } = require('telegram/client/uploads');
    const file = new CustomFile(d.media.name, ad.buffer.length, '', ad.buffer);
    const o = { file, caption: d.text || '', formattingEntities: ents };
    if (d.media.type === 'video' || d.media.type === 'animation') o.supportsStreaming = true;
    if (d.media.type === 'voice') o.voiceNote = true;
    if (d.media.type === 'document') o.forceDocument = true;
    const r = await client.sendFile(peer, o);
    if (r && r.media) ad.cache = r.media;
    return r;
  }
  if (!d.text) throw new Error('NO_TEXT_TO_SEND');
  return await client.sendMessage(peer, { message: d.text, formattingEntities: ents, linkPreview: true });
}

/** re-post without forwarding: keeps text, entities (bold/links/premium emoji), media, albums */
async function sendCopy(client, peer, ad, textOnly) {
  if (ad.kind === 'content') return sendContent(client, peer, ad, textOnly);
  const ms = ad.msgs;
  const m = ms[0];
  if (!textOnly && ms.length > 1 && ms.every((x) => isFileMedia(x.media))) {
    const files = ms.map((x) => x.media);
    try {
      const { HTMLParser } = require('telegram/extensions/html');
      const caps = ms.map((x) => HTMLParser.unparse(x.message || '', x.entities || []));
      return await client.sendFile(peer, { file: files, caption: caps, parseMode: 'html' });
    } catch (e) {
      if (errMsg(e) && /FLOOD|SLOWMODE|FORBIDDEN|BANNED|PRIVATE|WRITE/i.test(errMsg(e))) throw e;
      return await client.sendFile(peer, { file: files, caption: ms.map((x) => x.message || '') });
    }
  }
  if (!textOnly && isFileMedia(m.media)) {
    return await client.sendFile(peer, { file: m.media, caption: m.message || '', formattingEntities: m.entities || undefined });
  }
  const text = ms.map((x) => x.message || '').filter(Boolean)[0] || '';
  if (!text) throw new Error('NO_TEXT_TO_SEND');
  return await client.sendMessage(peer, {
    message: text,
    formattingEntities: m.entities || undefined,
    linkPreview: m.media instanceof Api.MessageMediaWebPage,
  });
}

function ruleFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t || !/\b(ad|ads|advert|promo|promotion|post|posting|message|msg)\b/.test(t)) return 0;
  let best = 0;
  const re1 = /(?:every|once|per|each|after|between|gap|wait|interval|only)[^\n.]{0,25}?(\d{1,3})\s*(min|mins|minute|minutes|m|hour|hours|hr|hrs|h)\b/g;
  const re2 = /(\d{1,3})\s*(min|mins|minute|minutes|hour|hours|hr|hrs|h)\s*(?:gap|interval|delay|cooldown|between)/g;
  for (const re of [re1, re2]) {
    let m;
    while ((m = re.exec(t))) {
      const n = Number(m[1]);
      const ms = /^h/.test(m[2]) ? n * 3600e3 : n * 60e3;
      if (ms > best && ms <= 48 * 3600e3) best = ms;
    }
  }
  if (/once (a|per) day|once daily|1 ad (a|per) day|every 24 ?h/.test(t)) best = Math.max(best, 24 * 3600e3);
  return Math.round(best / 1000);
}

/** slow mode + group-rule timer (pinned msg / about) for a supergroup */
async function detectMeta(client, peer, inputChannel) {
  const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }));
  const fc = full.fullChat;
  let rule = ruleFromText(fc.about);
  if (fc.pinnedMsgId) {
    try {
      const r = [].concat(await client.getMessages(peer, { ids: fc.pinnedMsgId }));
      rule = Math.max(rule, ruleFromText(r[0] && r[0].message));
    } catch (e) {}
  }
  return { slow: fc.slowmodeSeconds || 0, nextSend: fc.slowmodeNextSendDate || 0, rule };
}

module.exports = { toGramEntities, makeClient, classify, isAuthErr, enforceTag, fetchAd, sendCopy, detectMeta, errMsg, ruleFromText };
