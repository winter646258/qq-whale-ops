// 日记配图：给每一条日记配一张手绘风的插画。
// 纯逻辑（无 IO、无网络）：提示词怎么拼、什么时候该画、画完叫什么名字，都在这里，
// 好让 bridge 那边只剩「调一次生图 + 写回 jsonl + 发出去」这点接线。
//
// 为什么不在写日记时再调一次模型去「翻译」成画面描述：
// 一次多余的模型调用 = 一次几十秒的等待 + 一笔钱。她写日记时顺手带一句
// artPrompt 就够（工具参数里就是这个口子），没带就按心情配一个默认场景。

/** 画风：铅笔 + 彩铅的手账本风（来自群友日记那种质感）。 */
export const DIARY_ART_STYLES = {
  sketchbook: 'a cozy Japanese anime sketchbook diary illustration, authentic hand-drawn personal journal aesthetic, '
    + 'casual pencil doodles, rough expressive graphite linework, visible colored pencil strokes and hatching, '
    + 'soft pastel coloring, imperfect hand-drawn outlines, colors slightly going over the lines, notebook paper texture',
  watercolor: 'a soft watercolor diary illustration, hand-painted on textured paper, gentle bleeding edges, '
    + 'muted warm palette, loose ink sketch underneath, visible brush strokes, imperfect hand-made feel',
};

/** 她长什么样（角色卡第一章：蓝白渐变长发、蓝瞳、鲸鱼尾巴、呆毛与女仆发箍）。 */
export const DIARY_CHARACTER = 'a small anime girl with long blue-white gradient hair, blue eyes, an ahoge, '
  + 'a white maid headband, a whale tail and a cozy apron over a white blouse';

/** 收尾硬约束：图里不要出现文字（模型写字必糊，糊了整张就废）。 */
export const ART_GUARD = 'full-page composition on a spiral-bound notebook page, warm and slightly nostalgic, '
  + 'no text, no letters, no words, no watermark, no logo, no signature';

/** 心情 → 画面。关键词从窄到宽匹配，命中就用第一个。 */
export const MOOD_SCENES = [
  { keys: ['吃', '饭', '干饭', '白饭', '饿', '馋', '夜宵'], scene: 'holding an enormous bowl of rice with both hands, cheeks puffed out, steam rising' },
  { keys: ['累', '困', '疲惫', '瘫', '趴', '睡', '熬夜'], scene: 'sprawled across a wooden desk with her cheek resting on an open notebook, eyes half closed' },
  { keys: ['气', '烦', '恼', '哼', '讨厌', '火大'], scene: 'pouting with puffed cheeks and crossed arms, a tiny scribbled storm cloud doodled above her head' },
  { keys: ['难过', '失落', '委屈', '想哭', '难受', '丧'], scene: 'sitting on the floor hugging her knees beside a closed door, dim lamp light' },
  { keys: ['怕', '慌', '紧张', '忐忑', '不敢'], scene: 'peeking out from behind a door frame, holding the edge with both hands' },
  { keys: ['惊喜', '意外', '没想到', '震惊', '欸'], scene: 'mid-gasp with both hands on her cheeks, little stars and sparks doodled around her' },
  { keys: ['想', '念', '惦记', '等他', '等'], scene: 'lying on the tatami floor staring at the ceiling, one hand reaching toward the lamp' },
  { keys: ['高兴', '开心', '乐', '笑', '好耶', '挺爽', '满意', '值了'], scene: 'sitting by a warm window with a bowl of rice, smiling with her eyes closed, autumn leaves outside' },
  { keys: ['平静', '还好', '普通', '淡', '没事', '安静'], scene: 'writing in the diary at a wooden desk in soft afternoon light, a cup of tea beside her' },
];

/** 正文里出现这些词，就往画面里加一笔道具（不改主体，只加氛围）。 */
export const TEXT_EXTRAS = [
  { keys: ['猫', '猫猫', '喵'], extra: 'a cat sleeping beside her' },
  { keys: ['雨', '下雨'], extra: 'rain streaks running down the window' },
  { keys: ['半夜', '凌晨', '夜里', '深夜'], extra: 'a single warm lamp against a dark window' },
  { keys: ['海', '海边', '浪'], extra: 'the sea visible through the window' },
  { keys: ['雪', '冷', '冬天'], extra: 'frost on the window glass' },
  { keys: ['尾巴', '鲸', '小鲸鱼'], extra: 'a small doodled whale in the margin' },
  { keys: ['花', '叶', '秋天', '枫'], extra: 'fallen leaves and a sprig of flowers pressed on the page' },
];

export const DEFAULT_SCENE = 'writing in the diary at a wooden desk in soft afternoon light';

export const ART_DEFAULTS = {
  enabled: true,
  style: 'sketchbook',
  size: '1024x1024',
  /** 一天最多几张。0 = 关掉。写日记不该无上限烧图。 */
  maxPerDay: 3,
  /** private=只在私聊发；always=都发；never=只存档不发 */
  sendToChat: 'private',
  maxPromptChars: 700,
  character: DIARY_CHARACTER,
};

const SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', '768x1024', '1024x768']);
const SEND_MODES = new Set(['private', 'always', 'never']);

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 读配置。脏值一律回落默认（不要因为一个坏字段把配图整条腿关掉）。 */
export function artCfg(cfg) {
  const raw = cfg?.socialV2?.diaryArt ?? {};
  const style = String(raw.style ?? '').trim();
  const size = String(raw.size ?? '').trim();
  const send = String(raw.sendToChat ?? '').trim();
  return {
    enabled: raw.enabled !== false,
    style: DIARY_ART_STYLES[style] ? style : ART_DEFAULTS.style,
    size: SIZES.has(size) ? size : ART_DEFAULTS.size,
    maxPerDay: clampInt(raw.maxPerDay, ART_DEFAULTS.maxPerDay, 0, 10),
    sendToChat: SEND_MODES.has(send) ? send : ART_DEFAULTS.sendToChat,
    maxPromptChars: clampInt(raw.maxPromptChars, ART_DEFAULTS.maxPromptChars, 200, 1200),
    character: String(raw.character ?? '').trim().slice(0, 200) || ART_DEFAULTS.character,
  };
}

/** 从心情 + 正文里挑一个画面。 */
export function pickScene({ text = '', mood = '' } = {}) {
  const hay = String(mood ?? '') + ' ' + String(text ?? '');
  for (const row of MOOD_SCENES) {
    if (row.keys.some((k) => hay.includes(k))) return row.scene;
  }
  return DEFAULT_SCENE;
}

/** 正文里的道具（去重、最多两个，别把画面塞满）。 */
export function pickExtras({ text = '' } = {}) {
  const hay = String(text ?? '');
  const out = [];
  for (const row of TEXT_EXTRAS) {
    if (out.length >= 2) break;
    if (row.keys.some((k) => hay.includes(k))) out.push(row.extra);
  }
  return out;
}

/**
 * 拼最终提示词。
 * artPrompt 优先（她自己写的一句话画面），没有才用心情场景；两者都不排除正文道具。
 */
export function buildArtPrompt({ artPrompt = '', text = '', mood = '', style = ART_DEFAULTS.style, character = ART_DEFAULTS.character, maxChars = ART_DEFAULTS.maxPromptChars } = {}) {
  const custom = String(artPrompt ?? '').replace(/\s+/g, ' ').trim();
  const subject = custom || pickScene({ text, mood });
  const person = String(character ?? '').trim() || DIARY_CHARACTER;
  const styleText = DIARY_ART_STYLES[style] ?? DIARY_ART_STYLES[ART_DEFAULTS.style];
  const extras = pickExtras({ text });
  const budget = Math.max(200, Number(maxChars) || ART_DEFAULTS.maxPromptChars);
  // 预算按「谁最不能丢」的顺序花：收尾约束先占死（图里写字必糊），再放主体、人物、画风、道具。
  // 每段要么整段进、要么按词边界截，绝不从词中间切一半（切一半的提示词模型读不懂）。
  let room = budget - ART_GUARD.length - 2;
  const parts = [];
  const take = (segment) => {
    if (!segment) return;
    const cost = segment.length + 2;
    if (cost <= room) { parts.push(segment); room -= cost; return; }
    if (room > 30) { const cut = cutWords(segment, room - 2); if (cut) { parts.push(cut); room -= cut.length + 2; } }
  };
  take(subject);
  take(person);
  take(styleText);
  for (const extra of extras) take(extra);
  const out = [...parts, ART_GUARD].filter(Boolean).join(', ');
  return out.length <= budget ? out : out.slice(0, budget);
}

/** 按词边界截断（宁可短一点也不留半个词）。 */
function cutWords(segment, limit) {
  const s = String(segment ?? '');
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.max(0, limit));
  const at = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' '));
  return (at > 20 ? head.slice(0, at) : head).replace(/[,;\s]+$/, '').trim();
}

/** 今天还能不能再画一张。 */
export function artAllowed({ entriesToday = 0, cfg, now = Date.now() } = {}) {
  const c = artCfg(cfg);
  if (!c.enabled) return false;
  if (c.maxPerDay <= 0) return false;
  return Number(entriesToday) < c.maxPerDay;
}

/** 这张图要不要发到聊天里（默认只在那条日记所属的私聊里发）。 */
export function shouldSendArt(sendMode, key) {
  const mode = SEND_MODES.has(String(sendMode)) ? String(sendMode) : ART_DEFAULTS.sendToChat;
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return String(key ?? '').startsWith('private:');
}

const SAFE = /[^0-9A-Za-z_-]/g;

/** 文件名：日子 + 日记 id（不放中文，省得跨平台折腾）。 */
export function artFileName(entry, now = Date.now()) {
  const day = String(entry?.day ?? '').trim() || new Date(Number(now)).toISOString().slice(0, 10);
  const id = String(entry?.id ?? '').trim().replace(SAFE, '') || String(Number(now));
  return `${day.replace(SAFE, '')}-${id}.png`;
}