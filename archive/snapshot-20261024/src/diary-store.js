// 日记（jsonl）—— 纯逻辑模块。
//
// 为什么从 Markdown 换成 jsonl：
//   原来每行 `- [YYYY-MM-DD HH:mm] 正文`，正文里的换行被压成空格；更麻烦的是
//   正文若出现 `- ` 开头的内容，下一条读取时会被误认成新日记（条目计数对不上）。
//   jsonl 一行一条，正文里出现什么都不会破坏结构。
//
// 为什么加 mood 字段：
//   这张「人体系统」图里唯一整块空白的是「情绪系统：心情有状态、有原因、有时长」。
//   日记是她唯一能自然记录情绪的地方 —— 这是最便宜的人口。
//   但**不给 mood 设枚举**：让她随便写，系统不做分类、不统计情绪分布。
//   一旦写成固定几档，她就会开始"贴标签"而不是"记事"。
//
// 为什么加 level 字段（分档 + 遗忘曲线）：
//   「记忆系统」那一栏写的是「日记分层：非常重要（永不删）/ 重要（两三周慢慢淡）/
//   普通（几天就忘）」「日常琐事像人一样慢慢淡」。原来是扁平的，写进去就永久等重。
//   这里的「淡」是**读的时候慢慢想不起来**，不是物理删除 ——
//   日记本不该被系统偷偷撕页，所以这里只算权重，不做自动清理。
//   清理只保留给控制台手动。
//
// 时间戳：
//   旧代码用 `new Date().toISOString()`（UTC），服务器是 Asia/Shanghai，
//   每条都差 8 小时 —— 深夜写的日记会显示成下午。这里统一走本地时间。
//
// 兼容：
//   旧的 diary/日记.md 仍可读（只读），用于迁移/回看；新写入一律进 .jsonl。
//   旧条目没有 level 字段 ⇒ 一律当 normal（不追认成重要，也不当成垃圾）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DIARY_JSONL = '日记.jsonl';
export const DIARY_LEGACY_MD = '日记.md';

export const MAX_ENTRIES = 2000;
export const MAX_TEXT_CHARS = 200;
export const MAX_MOOD_CHARS = 20;
export const MAX_BYTES = 2 * 1024 * 1024;

/** 三档，从轻到重。顺序有意义：索引越大越难忘。 */
export const LEVELS = ['normal', 'important', 'critical'];
export const DEFAULT_LEVEL = 'normal';

/**
 * 半衰期（天）：权重降到一半要多久。
 * normal 5 天 ≈「几天就忘」，important 21 天 ≈「两三周慢慢淡」，
 * critical 无穷大 = 权重恒为 1，永不淡。
 * 这两个数字对应图上的原话，不是拍脑袋。
 */
export const LEVEL_HALF_LIFE_DAYS = { normal: 5, important: 21, critical: Infinity };

/** 给模型/控制台看的中文名。 */
export const LEVEL_LABELS = { normal: '普通', important: '重要', critical: '不想忘' };

/** 权重低于这个值就算「想不太起来了」，默认不再出现在回想视图里。 */
export const FADE_THRESHOLD = 0.15;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间 `YYYY-MM-DD HH:mm`（Asia/Shanghai，服务器已设该时区）。 */
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时间 `YYYY-MM-DD`。 */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 把模型给的字符串归一到三档。
 * 容错中文和近义词：她可能写「非常重要」「重要」「关键」，
 * 也可能把字段填成 true/1 —— 一律落回 normal，不报错（日记不该因为标注失败而写不进去）。
 */
export function normalizeLevel(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return DEFAULT_LEVEL;
  if (s === 'critical' || s === '非常重要' || s === '永不删' || s === '永远' || s === '关键' || s === '3') return 'critical';
  if (s === 'important' || s === '重要' || s === '2') return 'important';
  if (s === 'normal' || s === '普通' || s === '1') return 'normal';
  return DEFAULT_LEVEL;
}

/**
 * 这一条现在还剩多少「记得住」的分量，0~1。
 * 只跟档位和时间有关，不跟访问次数有关（不做间隔重复，那太像背单词）。
 */
export function diaryWeight(entry, now = Date.now()) {
  const level = normalizeLevel(entry?.level);
  if (level === 'critical') return 1;
  const t = Number(entry?.t) || 0;
  // 迁移过来的旧数据没有时间戳：给中间值，不冤枉也不抬高
  if (!t) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return Math.pow(0.5, ageDays / LEVEL_HALF_LIFE_DAYS[level]);
}

/** 权重是否已经淡到「不会主动想起来」。 */
export function isFaded(entry, now = Date.now()) {
  return diaryWeight(entry, now) < FADE_THRESHOLD;
}

function cleanText(raw, max = MAX_TEXT_CHARS) {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')     // 换行压成空格：一条日记就该是一行
    .trim()
    .slice(0, max);
}

function cleanMood(raw) {
  return String(raw ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_MOOD_CHARS);
}

/**
 * 解析一行 jsonl。坏行返回 null（不抛错——一条坏行不该让整个日记读不出来）。
 */
function parseLine(line) {
  const s = String(line ?? '').trim();
  if (!s) return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const text = cleanText(obj.text);
  if (!text) return null;
  const t = Number(obj.t);
  return {
    id: String(obj.id || '').trim() || null,
    t: Number.isFinite(t) && t > 0 ? t : 0,
    time: String(obj.time || '').trim() || (Number.isFinite(t) && t > 0 ? localStamp(new Date(t)) : ''),
    day: String(obj.day || '').trim() || (Number.isFinite(t) && t > 0 ? localDay(new Date(t)) : ''),
    mood: cleanMood(obj.mood),
    level: normalizeLevel(obj.level),
    text,
    editedAt: Number(obj.editedAt) > 0 ? Number(obj.editedAt) : 0
  };
}

/**
 * 读全部日记（按时间升序）。
 * 文件不存在 ⇒ 空数组；坏行跳过；读不动**抛错**（由调用方决定降级，
 * 绝不当成空日记再写回去 —— 那会把整本日记清空）。
 */
export function readDiary(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const line of text.split('\n')) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0));
  return out;
}

/** 原子写全部日记（临时文件 + rename），权限 600。 */
export function writeDiary(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.text)
    .map((e) => JSON.stringify({
      id: e.id,
      t: e.t,
      time: e.time,
      day: e.day,
      ...(e.mood ? { mood: e.mood } : {}),
      // 只写非默认档：normal 是缺省，不落盘就不占字节，也顺手让旧文件读起来一样
      ...(normalizeLevel(e.level) !== DEFAULT_LEVEL ? { level: normalizeLevel(e.level) } : {}),
      text: e.text,
      ...(e.editedAt ? { editedAt: e.editedAt } : {})
    }));
  const payload = lines.join('\n') + (lines.length ? '\n' : '');
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return Buffer.byteLength(payload, 'utf8');
}

function newId(taken) {
  for (let i = 0; i < 100; i += 1) {
    const id = 'd' + crypto.randomBytes(3).toString('hex').slice(0, 5);
    if (!taken.has(id)) return id;
  }
  return 'd' + Date.now().toString(16).slice(-5);
}

/**
 * 追加一条。返回新增的 entry。
 * mood / level 都可选 —— 不传就不写这个字段（不给个默认值，省得每条都带个假心情）。
 */
export function appendDiaryEntry(entries, { text, mood, level, now = Date.now() } = {}) {
  const t = cleanText(text);
  if (!t) throw new Error('日记内容不能为空');
  const list = Array.isArray(entries) ? entries : [];
  if (list.length >= MAX_ENTRIES) throw new Error(`日记条数已达上限（${MAX_ENTRIES} 条）`);

  const taken = new Set(list.map((e) => e.id).filter(Boolean));
  const d = new Date(now);
  const entry = {
    id: newId(taken),
    t: now,
    time: localStamp(d),
    day: localDay(d),
    mood: cleanMood(mood),
    level: normalizeLevel(level),
    text: t,
    editedAt: 0
  };
  list.push(entry);
  return entry;
}

/**
 * 改写一条（按 id 或按正文片段匹配）。
 *
 * 注意这里**没有** originalText：日记不是"印象"，改写就是改写。
 * 人会重读自己写的东西然后改口，这是日记的正常行为，不必留底。
 * （「模糊是改写不是删除」那条原则是给记忆用的，不是给日记用的。）
 *
 * level 也可以改 —— 「当时觉得普通，后来发现忘不掉」是常见的事，
 * 反过来降档也允许：她会重新掂量。
 */
export function updateDiaryEntry(entries, { id, oldText, text, mood, level, now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let hit = null;
  if (id) {
    hit = list.find((e) => e.id === String(id).trim()) || null;
  }
  if (!hit && oldText) {
    const needle = String(oldText).trim();
    if (needle) {
      // 从后往前找：最近写的更可能是她想改的那条
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (String(list[i].text || '').includes(needle)) { hit = list[i]; break; }
      }
    }
  }
  if (!hit) return null;

  let changed = false;
  if (text !== undefined && text !== null && String(text).trim() !== '') {
    const next = cleanText(text);
    if (next && next !== hit.text) { hit.text = next; changed = true; }
  }
  if (mood !== undefined && mood !== null) {
    const nextMood = cleanMood(mood);
    if (nextMood !== hit.mood) { hit.mood = nextMood; changed = true; }
  }
  if (level !== undefined && level !== null && String(level).trim() !== '') {
    const nextLevel = normalizeLevel(level);
    if (nextLevel !== normalizeLevel(hit.level)) { hit.level = nextLevel; changed = true; }
  }
  if (changed) hit.editedAt = now;
  return { entry: hit, changed };
}

/** 删一条。日记**不提供**删除给角色（那是管理员干的活），所以这个函数只给控制台用。 */
export function removeDiaryEntry(entries, id) {
  const list = Array.isArray(entries) ? entries : [];
  const sid = String(id ?? '').trim();
  const idx = list.findIndex((e) => e.id === sid);
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}

/** 最近 N 条（新的在后，便于她顺着读）。保留旧接口，recallDiary 是新接口。 */
export function recentDiary(entries, limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  return (Array.isArray(entries) ? entries : []).slice(-n);
}

/**
 * 回想视图：最近写的 + 更早还值得想起来的。
 *
 * 这是「遗忘曲线」唯一外显的地方 —— 两个视图的分工是：
 *   recent：不管权重，最近 N 条照给（刚发生的事她本来就该记得）；
 *   faded ：从更早的里挑还够分量的。普通条目过了几天权重就掉到门槛以下，
 *           于是自然不再出现在这里 —— 这就是「几天就忘」，但数据还在文件里。
 * critical 无条件优先（图上的「永不删」），不受门槛限制。
 */
export function recallDiary(entries, { now = Date.now(), recent = 10, faded = 4, minWeight = FADE_THRESHOLD } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const n = Math.max(1, Math.min(100, Number(recent) || 10));
  const recentList = list.slice(-n);
  const recentIds = new Set(recentList.map((e) => e.id).filter(Boolean));
  const cap = Math.max(0, Math.min(20, Number(faded) || 0));
  if (!cap) return { recent: recentList, faded: [] };
  const older = list
    .filter((e) => !(e.id && recentIds.has(e.id)))
    .map((e) => ({ entry: e, weight: diaryWeight(e, now), level: normalizeLevel(e.level) }))
    .filter((x) => x.level === 'critical' || x.weight >= minWeight)
    .sort((a, b) => {
      if (a.level === 'critical' && b.level !== 'critical') return -1;
      if (b.level === 'critical' && a.level !== 'critical') return 1;
      return (b.weight - a.weight) || ((b.entry.t || 0) - (a.entry.t || 0));
    })
    .slice(0, cap);
  return { recent: recentList, faded: older.map((x) => x.entry) };
}

/** 上次写日记是几天前；没有日记返回 null。 */
export function daysSinceLast(entries, now = Date.now()) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => Number(e?.t) > 0);
  if (!list.length) return null;
  const last = list.reduce((mx, e) => Math.max(mx, Number(e.t) || 0), 0);
  if (!last) return null;
  return Math.max(0, Math.floor((now - last) / 86400000));
}

/** 按天分组后的摘要（给"翻日记"用的轻量视图）。 */
export function diaryDays(entries) {
  const map = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const day = e.day || (e.t ? localDay(new Date(e.t)) : '未知');
    map.set(day, (map.get(day) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count }));
}

/**
 * 兼容读取旧的 Markdown 日记（只读）。
 * 只为把已有内容迁过来 / 让人回看，新写入一律进 jsonl。
 */
export function parseLegacyMarkdown(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('- ')) continue;
    const m = /^-\s*\[([^\]]+)\]\s*(.*)$/.exec(s);
    const stamp = m ? m[1].trim() : '';
    const body = cleanText(m ? m[2] : s.slice(2));
    if (!body) continue;
    // 旧时间戳是 UTC，这里只做展示迁移，不去纠时区（历史数据保持原样，不假装精确）
    out.push({ id: null, t: 0, time: stamp, day: (stamp || '').slice(0, 10), mood: '', level: DEFAULT_LEVEL, text: body, editedAt: 0 });
  }
  return out;
}

/**
 * 数据自检：条数 / 字节 / 最早最晚时间 / 分档计数 / 已经淡掉的条数 / 上次写是几天前。
 */
export function diaryStats(entries, now = Date.now()) {
  const list = Array.isArray(entries) ? entries : [];
  const withT = list.filter((e) => e.t > 0);
  const byLevel = { normal: 0, important: 0, critical: 0 };
  let fadedCount = 0;
  for (const e of list) {
    byLevel[normalizeLevel(e.level)] += 1;
    if (isFaded(e, now)) fadedCount += 1;
  }
  return {
    count: list.length,
    firstAt: withT.length ? withT[0].time : '',
    lastAt: withT.length ? withT[withT.length - 1].time : '',
    withMood: list.filter((e) => e.mood).length,
    days: diaryDays(list).length,
    byLevel,
    fadedCount,
    daysSinceLast: daysSinceLast(list, now)
  };
}