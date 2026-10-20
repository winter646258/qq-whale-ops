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
// 时间戳：
//   旧代码用 `new Date().toISOString()`（UTC），服务器是 Asia/Shanghai，
//   每条都差 8 小时 —— 深夜写的日记会显示成下午。这里统一走本地时间。
//
// 兼容：
//   旧的 diary/日记.md 仍可读（只读），用于迁移/回看；新写入一律进 .jsonl。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DIARY_JSONL = '日记.jsonl';
export const DIARY_LEGACY_MD = '日记.md';

export const MAX_ENTRIES = 2000;
export const MAX_TEXT_CHARS = 200;
export const MAX_MOOD_CHARS = 20;
export const MAX_BYTES = 2 * 1024 * 1024;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间 `YYYY-MM-DD HH:mm`（Asia/Shanghai，服务器已设该时区）。 */
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时间 `YYYY-MM-DD`。 */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
 * mood 可选 —— 不传就不写这个字段（不给个默认值，省得每条都带个假心情）。
 */
export function appendDiaryEntry(entries, { text, mood, now = Date.now() } = {}) {
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
 */
export function updateDiaryEntry(entries, { id, oldText, text, mood, now = Date.now() } = {}) {
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

/** 最近 N 条（新的在后，便于她顺着读）。 */
export function recentDiary(entries, limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  return (Array.isArray(entries) ? entries : []).slice(-n);
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
    out.push({ id: null, t: 0, time: stamp, day: (stamp || '').slice(0, 10), mood: '', text: body, editedAt: 0 });
  }
  return out;
}

/**
 * 数据自检：条数 / 字节 / 最早最晚时间。
 */
export function diaryStats(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const withT = list.filter((e) => e.t > 0);
  return {
    count: list.length,
    firstAt: withT.length ? withT[0].time : '',
    lastAt: withT.length ? withT[withT.length - 1].time : '',
    withMood: list.filter((e) => e.mood).length,
    days: diaryDays(list).length
  };
}
