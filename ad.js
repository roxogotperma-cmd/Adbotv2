// Turns the message a user sends (text / photo / video / ... with formatting & premium emoji) into a stored ad.
const MAX_FILE = 20 * 1024 * 1024; // Bot API getFile limit
const KEEP = new Set(['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'text_link', 'spoiler', 'blockquote', 'expandable_blockquote', 'custom_emoji']);

const slim = (e) => {
  const o = { type: e.type, offset: e.offset, length: e.length };
  if (e.url) o.url = e.url;
  if (e.language) o.language = e.language;
  if (e.custom_emoji_id) o.custom_emoji_id = e.custom_emoji_id;
  return o;
};
function pickMedia(m) {
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return { type: 'photo', file_id: p.file_id, size: p.file_size || 0, name: 'photo.jpg' }; }
  if (m.video) return { type: 'video', file_id: m.video.file_id, size: m.video.file_size || 0, name: m.video.file_name || 'video.mp4' };
  if (m.animation) return { type: 'animation', file_id: m.animation.file_id, size: m.animation.file_size || 0, name: m.animation.file_name || 'animation.mp4' };
  if (m.document) return { type: 'document', file_id: m.document.file_id, size: m.document.file_size || 0, name: m.document.file_name || 'file.bin' };
  if (m.audio) return { type: 'audio', file_id: m.audio.file_id, size: m.audio.file_size || 0, name: m.audio.file_name || 'audio.mp3' };
  if (m.voice) return { type: 'voice', file_id: m.voice.file_id, size: m.voice.file_size || 0, name: 'voice.ogg' };
  return null;
}

/** -> {kind:'content'|'link', ...} or {error} */
function fromMessage(m) {
  const fo = m.forward_origin;
  if (fo && fo.type === 'channel' && fo.chat && fo.chat.username && fo.message_id)
    return { kind: 'link', url: `https://t.me/${fo.chat.username}/${fo.message_id}` }; // forwarded public post -> forward mode
  if (m.sticker || m.video_note || m.poll || m.location || m.contact || m.dice)
    return { error: 'This type is not supported. Send text, photo, video, GIF, document, audio or voice.' };
  if (m.media_group_id) return { error: 'Albums are not supported here. Send ONE message, or forward/paste a public post link for albums.' };
  const text = m.text != null ? m.text : m.caption || '';
  const ents = (m.entities || m.caption_entities || []).filter((e) => KEEP.has(e.type)).map(slim);
  const media = pickMedia(m);
  if (!media) {
    const t = text.trim();
    if (!t) return { error: 'Empty message. Send your ad text or media.' };
    if (text.length > 4096) return { error: 'Text too long (max 4096 characters).' };
    return { kind: 'content', text, entities: ents, media: null };
  }
  if (media.size > MAX_FILE) return { error: 'File too big (max 20 MB).' };
  if (text.length > 1024) return { error: 'Caption too long (max 1024 characters).' };
  return { kind: 'content', text, entities: ents, media };
}

function label(d) {
  if (!d) return 'not set';
  if (d.kind === 'link') return '🔗 Post link: ' + d.url;
  if (d.media) return `🖼 ${d.media.type}${d.text ? ' + caption (' + d.text.length + ' chars)' : ''}`;
  return `📝 Text (${(d.text || '').length} chars)`;
}
module.exports = { fromMessage, label };
