// 日记本：把「日记 + 配图」当成一个专门的存档处来组织（不进聊天）。
// 纯逻辑：按月分组、取一页、配图的 URL 与安全路径解析。
import path from 'node:path';

/** 'YYYY-MM-DD' → 'YYYY-MM'。认不出来就空串。 */
export function monthOf(day) {
  const s = String(day ?? '').trim();
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}

/** 有哪些月、各几条（新的在前）。 */
export function bookMonths(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const map = new Map();
  for (const e of list) {
    const m = monthOf(e?.day);
    if (!m) continue;
    map.set(m, (map.get(m) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, count]) => ({ month, count }));
}

/** 配图对外的地址（页面用它取图）。 */
export function artUrlFor(file) {
  const rel = String(file ?? '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!rel || rel.includes('..')) return '';
  return '/api/socialV2/diary/art/' + rel.split('/').map(encodeURIComponent).join('/');
}

/**
 * 把配图的相对名解析成真实路径，并且**只允许 art 目录里的 .png**。
 * 返回 null 表示不合法（穿越、非 png、绝对路径）。
 */
export function resolveArtFile(artDir, rel) {
  // 空目录名不能交给 path.resolve（它会变成当前工作目录，于是「空根目录」也敢返回路径）
  const dirRaw = String(artDir ?? '').trim();
  if (!dirRaw) return null;
  const root = path.resolve(dirRaw);
  const raw = String(rel ?? '').replace(/\\/g, '');
  // 绝对路径直接拒（不靠 strip 之后的巧合过关）：进来的只该是 2026-10/xxx.png 这种相对名
  if (!raw || raw.startsWith('/') || raw.includes(':')) return null;
  const name = raw.replace(/^\/+/, '').trim();
  if (!root || !name) return null;
  if (name.includes('\0') || name.split('/').includes('..')) return null;
  if (path.isAbsolute(name)) return null;
  if (!/\.png$/i.test(name)) return null;
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * 取一页日记（新的在前）。artExists 由调用方给（这里不碰文件系统，方便单测）。
 */
export function bookItems(entries, { month = '', limit = 200, artExists = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const want = String(month ?? '').trim();
  const cap = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
  const picked = [];
  for (let i = list.length - 1; i >= 0 && picked.length < cap; i -= 1) {
    const e = list[i];
    if (!e || !e.text) continue;
    if (want && monthOf(e.day) !== want) continue;
    const file = e.art && e.art.file ? String(e.art.file) : '';
    const exists = file ? (typeof artExists === 'function' ? Boolean(artExists(file)) : true) : false;
    picked.push({
      id: e.id ?? '',
      t: Number(e.t) || 0,
      time: e.time ?? '',
      day: e.day ?? '',
      mood: e.mood ?? '',
      level: e.level ?? 'normal',
      text: e.text,
      art: file ? { file, url: exists ? artUrlFor(file) : '', exists, style: e.art?.style ?? '' } : null
    });
  }
  return picked;
}

/** 概览：总条数、有配图几条、覆盖的日子、出现过的心情。 */
export function bookSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let withArt = 0;
  const days = new Set();
  const moods = new Set();
  for (const e of list) {
    if (!e || !e.text) continue;
    if (e.art && e.art.file) withArt += 1;
    if (e.day) days.add(String(e.day));
    if (e.mood) moods.add(String(e.mood));
  }
  const sorted = [...days].sort();
  return {
    total: list.filter((e) => e && e.text).length,
    withArt,
    days: days.size,
    firstDay: sorted[0] ?? '',
    lastDay: sorted[sorted.length - 1] ?? '',
    moods: [...moods].slice(0, 30)
  };
}