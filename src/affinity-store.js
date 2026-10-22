// 好感度（affinity）—— 按会话各存一份，可被注入到唤醒 prompt。
//
// 为什么单独一个模块，而不是塞进 mood-store.js：
//   mood-store 里那份 affinity 是**全局单值**，一个文件一个值，所有会话共享。
//   实测的后果：她跟任何人聊（包括群友），心里想的都是「半夜折腾着给我接生图、
//   捏 mc 小人的那个」—— 那是主人专属的话。注入之后她会在群里对着群友说
//   「我对你挺有好感的」，串台比不显示更糟。
//
// 三条设计约束（主人 2026-10-22 定的）：
//   1. **按会话各存一份**：主人私聊一份、每个群一份、每个好友私聊一份，互不串台。
//   2. **保持手动，不由系统自动打分**：只在她长期没动过时提醒一句该看了。
//      原作者在 mood-store.js 里就写明不做自动打分，理由是「自动打分会把
//      每次对话都变成算分」，这里沿用同一条哲学。
//   3. **只注入 note 原文，不注入数字**：图里写的是「好感度：一个大概的秤，
//      不被数字框住，喜欢谁由她自己判断」。数字给她只会让她在聊天里把分数说出来。

export const AFFINITY_MIN = 1;
export const AFFINITY_MAX = 10;
export const AFFINITY_NOTE_MAX_CHARS = 120;
/** 多久没动过就提醒她看一眼（14 天）。 */
export const AFFINITY_NUDGE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** 提醒的冷却：同一会话 7 天内最多念一次，免得天天唠叨。 */
export const AFFINITY_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** 合法会话 key：`group:数字` 或 `private:数字`。 */
export function normalizeAffinityKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = m[2].replace(/^0+(?=\d)/, '');
  if (!id || !Number.isSafeInteger(Number(id))) return null;
  return `${m[1]}:${id}`;
}

/** 一句话描述，压到上限、去掉换行。 */
export function cleanAffinityNote(note) {
  const s = String(note ?? '').replace(/\s+/g, ' ').trim();
  return s.length > AFFINITY_NOTE_MAX_CHARS ? s.slice(0, AFFINITY_NOTE_MAX_CHARS) : s;
}

/** 夹到 1~10 的整数；非数字返回 null（让调用方区分「没给」和「给了 0」）。 */
export function clampAffinityLevel(level) {
  if (level === undefined || level === null || level === '') return null;
  const n = Number(level);
  if (!Number.isFinite(n)) return null;
  return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, Math.round(n)));
}

/**
 * 归一化单个会话的好感度记录。
 * 缺字段补默认，坏数据丢掉（返回 null 让上层过滤）。
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const level = clampAffinityLevel(raw.level);
  const note = cleanAffinityNote(raw.note);
  const at = Number(raw.updatedAt);
  // 级别和 note 都没有 = 空壳，当没存过
  if (level === null && !note) return null;
  return {
    level: level === null ? AFFINITY_MIN : level,
    note,
    updatedAt: Number.isFinite(at) && at > 0 ? at : 0
  };
}

/**
 * 归一化整张好感度表。
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, {level:number, note:string, updatedAt:number}>}
 */
export function normalizeAffinityMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeAffinityKey(k);
    if (!key) continue;
    const entry = normalizeEntry(v);
    if (entry) out[key] = entry;
  }
  return out;
}

/**
 * 读某个会话的好感度。
 *
 * ⚠️ **不回退到全局**：老格式里那份全局 affinity 是「最后在哪说的就归谁」，
 * 拿它当所有人的默认值正是要消灭的串台。没存过就是没存过。
 *
 * @param {Record<string, unknown>} map
 * @param {string} key
 * @returns {{level:number, note:string, updatedAt:number}|null}
 */
export function getAffinity(map, key) {
  const k = normalizeAffinityKey(key);
  if (!k) return null;
  const entry = normalizeEntry(map?.[k]);
  return entry ?? null;
}

/**
 * 写某个会话的好感度。level 和 note 各自独立更新（只传一个就只改一个）。
 *
 * @param {Record<string, unknown>} map 现有表（不会被原地修改）
 * @param {{key: string, level?: number, note?: string, now?: number}} opts
 * @returns {{map: Record<string, unknown>, entry: object}}
 */
export function setAffinity(map, { key, level, note, now = Date.now() } = {}) {
  const k = normalizeAffinityKey(key);
  if (!k) throw new Error('好感度必须指定会话 key（group:群号 或 private:QQ号）');
  const next = { ...normalizeAffinityMap(map) };
  const before = next[k] ?? { level: AFFINITY_MIN, note: '', updatedAt: 0 };
  let nextLevel = before.level;
  if (level !== undefined && level !== null && level !== '') {
    const n = Number(level);
    if (!Number.isFinite(n)) throw new Error('好感度必须是数字');
    if (n < AFFINITY_MIN || n > AFFINITY_MAX) {
      throw new Error(`好感度只能是 ${AFFINITY_MIN}~${AFFINITY_MAX}`);
    }
    nextLevel = Math.round(n);
  }
  const nextNote = note === undefined ? before.note : cleanAffinityNote(note);
  const entry = { level: nextLevel, note: nextNote, updatedAt: now };
  next[k] = entry;
  return { map: next, entry };
}

/**
 * 该不该提醒她「看看好感度」。
 *
 * 三个条件全满足才提醒：
 *   1. 这个会话有 note（没写过就别催，她可能根本还没想好怎么看这个人）
 *   2. 距上次改动超过 AFFINITY_NUDGE_AFTER_MS
 *   3. 距上次提醒超过 AFFINITY_NUDGE_COOLDOWN_MS
 *
 * @param {{entry: object|null, lastNudgedAt?: number, now?: number}} opts
 * @returns {boolean}
 */
export function shouldNudgeAffinity({ entry, lastNudgedAt = 0, now = Date.now() } = {}) {
  if (!entry || !entry.note) return false;
  const at = Number(entry.updatedAt) || 0;
  if (!at) return false;
  if (now - at < AFFINITY_NUDGE_AFTER_MS) return false;
  const nudged = Number(lastNudgedAt) || 0;
  if (nudged && now - nudged < AFFINITY_NUDGE_COOLDOWN_MS) return false;
  return true;
}

/**
 * 拼进唤醒 prompt 的那一行。
 *
 * 只给 note 原文 —— 不给数字（主人定的第三条）。没有 note 就返回空串，
 * 一个字都不提：她没想好怎么看待这个人时，催她想反而是干扰。
 *
 * @param {{entry: object|null, key: string, ownerQQ?: string|number}} opts
 * @returns {string}
 */
export function formatAffinityLine({ entry, key, ownerQQ } = {}) {
  if (!entry || !entry.note) return '';
  const isOwner = String(key) === `private:${ownerQQ}`;
  return `【你怎么看${isOwner ? '主人' : '这个人'}】${entry.note}\n\n`;
}

/**
 * 拼提醒那一行（长期没动过好感度时）。
 *
 * 语气要轻：不是任务，是提醒。她可以选择不动。
 *
 * @param {{entry: object|null, key: string, ownerQQ?: string|number, now?: number}} opts
 * @returns {string}
 */
export function formatAffinityNudge({ entry, key, ownerQQ } = {}) {
  if (!entry) return '';
  const isOwner = String(key) === `private:${ownerQQ}`;
  const who = isOwner ? '主人' : '这个人';
  return `【好感度】你对${who}的那句评价是很久以前写的了。现在还这么看吗？想改就用 qq_mood action=affinity 重写一句；不想改就放着，不用汇报。\n\n`;
}

// ── IO ────────────────────────────────────────────────────────────────
// 存独立文件，不跟情绪混一起：情绪有衰减、有好几块结构，
// 好感度是「按会话一张表」，放一起容易互相覆盖。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 读好感度表。文件不存在返回空表（首次运行是常态，不是错误）。
 *
 * @param {string} file
 * @returns {{version: number, affinities: Record<string, object>, nudgeAt: Record<string, number>}}
 */
export function loadAffinityState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeAffinityState(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeAffinityState({});
    // 损坏的文件不能静默重置 —— 那就把所有人的好感度一次抹了。
    throw error;
  }
}

/** 归一化整个状态文件。 */
export function normalizeAffinityState(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const nudgeAt = {};
  if (o.nudgeAt && typeof o.nudgeAt === 'object') {
    for (const [k, v] of Object.entries(o.nudgeAt)) {
      const key = normalizeAffinityKey(k);
      const n = Number(v);
      if (key && Number.isFinite(n) && n > 0) nudgeAt[key] = n;
    }
  }
  return {
    version: 1,
    affinities: normalizeAffinityMap(o.affinities),
    nudgeAt
  };
}

/** 写好感度表（tmp + rename，权限 600）。 */
export function saveAffinityState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(normalizeAffinityState(state), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
