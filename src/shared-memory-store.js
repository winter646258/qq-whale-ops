// 跨会话共享记忆 —— 纯逻辑模块。
//
// 要解决的问题（作业原话）：
//   「主人私聊能了解小鲸鱼在群聊和其他场景经历的重要事情，同时保护私聊专属内容和
//     群聊专属内容。」
//
// 与已有三套记忆的分工（别再做一个重复系统）：
//   - memberImpressions（social-v2.json 内）：**会话内的短标签**（话多、爱怼人），
//     跟着某个群走，按会话隔离。
//   - 画像 portrait.json：**跨会话的、她自己写的、会随时间改口的判断**，
//     主体是「人」。
//   - 日记 日记.jsonl：**按天记的事**，主体是「时间」。
//   - 本模块：**事件与约定的摘要**，主体是「这件事发生在哪、能给谁看」。
//     它不记人（那是画像），不记天（那是日记），只记「值得跨场景记住的一句话」。
//
// 三条硬约束（作业里点名的发布阻断项）：
//   一、按受众过滤 —— 主人私聊专属内容绝不进入群聊；群聊内容不会自动进主人私聊，
//       只有她自己把摘要写成 shared 才进得去（写不写归她判断，不归定时器判断）。
//   二、角色判断、系统限流 —— 记什么由她定；条数、字数、注入量由本模块硬卡。
//   三、模糊/遗忘不是永久删除 —— forget 只把 status 改成 forgotten，正文留着可恢复。
//
// 可见性矩阵（scope × reader），由 canRead 单点实现，测试逐格覆盖：
//
//                 reader = owner        reader = group:X
//   shared        可读                  仅 visibleGroups 含 X 时
//   owner_private 可读                  永不可读
//   group:X       不自动注入（可由她转述） 仅 X 自己可读
//   group:Y       不可读                 不可读
//
// 「group:X 对 owner 不自动注入」是刻意的：群聊专属内容要进主人私聊，得她自己
// 写一条 shared 摘要（或走主动报告），而不是桥接把整段群聊递过去。
//
// shared 的对群可见性是**按群点名的**（visibleGroups），不是一个「对全世界公开」
// 的布尔开关：在 A 群学到的梗搬到 B 群，B 群的人根本没有那个上下文，那不是共享
// 记忆，那是串台。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SHARED_MEMORY_VERSION = 1;

/** 全库条数上限（active 计价）。 */
export const MAX_ITEMS = 30;
/** 单条正文上限。作业要求「不超过 80 字」。 */
export const MAX_TEXT_CHARS = 80;
export const MAX_SOURCE_CHARS = 120;
export const MAX_ID_CHARS = 24;
/** archived 只留这么多条可恢复，再老的才真丢。 */
export const MAX_ARCHIVED = 60;

export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 9;

/** 每轮注入：最多几条、最多多少字。塞满每轮都在烧上下文，角色反而看不进去。 */
export const INJECT_MAX_ITEMS = 8;
export const INJECT_MAX_CHARS = 600;

const GROUP_SCOPE_RE = /^group:(\d{1,20})$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const SCOPES = Object.freeze(['shared', 'owner_private']);
export const STATUSES = Object.freeze(['active', 'forgotten', 'archived']);

function isBadKey(raw) {
  return BAD_KEYS.has(String(raw ?? '').trim());
}

/**
 * 把输入规范成三种 scope 之一，认不出返回 null（调用方决定是抛错还是忽略）。
 * 接受：shared / 共享 / owner_private / owner / private / 私聊 / group:123 / 群:123
 */
export function normalizeScope(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (isBadKey(s)) return null;
  if (GROUP_SCOPE_RE.test(s)) return s;
  const g = /^(?:群|group)[::]?(\d{1,20})$/.exec(s);
  if (g) return `group:${g[1]}`;
  const lower = s.toLowerCase();
  if (lower === 'shared' || s === '共享') return 'shared';
  if (lower === 'owner_private' || lower === 'owner' || lower === 'private' || s === '私聊') return 'owner_private';
  return null;
}

/** 判断某个 scope 是否指向群，返回群号或 null。 */
export function groupIdOfScope(scope) {
  const m = GROUP_SCOPE_RE.exec(String(scope ?? '').trim());
  return m ? m[1] : null;
}

/** 受众描述子。ownerReader / groupReader 是唯二的构造入口。 */
export function ownerReader() {
  return Object.freeze({ kind: 'owner' });
}

export function groupReader(groupId) {
  const id = String(groupId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error(`群号不合法（收到「${groupId}」）`);
  return Object.freeze({ kind: 'group', id });
}

function cleanId(raw) {
  const s = String(raw ?? '').trim();
  if (!s || isBadKey(s)) return '';
  return s.slice(0, MAX_ID_CHARS);
}

function cleanText(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

function cleanSource(raw) {
  return String(raw ?? '').trim().slice(0, MAX_SOURCE_CHARS);
}

/** 群号列表归一化：去重、只留纯数字、最多 20 个。 */
function cleanGroupList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const id = String(v ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

function clampImportance(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return IMPORTANCE_MIN;
  return Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, n));
}

function emptyStore() {
  return { version: SHARED_MEMORY_VERSION, items: [] };
}

function ts(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const scope = normalizeScope(raw.scope);
  if (!scope) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'active';
  return {
    id: cleanId(raw.id),
    text,
    scope,
    // 只有 shared 项才可能进群；owner_private / group:* 一律没有这个开关。
    visibleGroups: scope === 'shared' ? cleanGroupList(raw.visibleGroups) : [],
    pinned: raw.pinned === true,
    importance: clampImportance(raw.importance),
    sourceRef: cleanSource(raw.sourceRef) || null,
    status,
    createdAt: ts(raw.createdAt) || Date.now(),
    lastMentionAt: ts(raw.lastMentionAt),
    updatedAt: ts(raw.updatedAt),
    forgottenAt: ts(raw.forgottenAt),
    archivedAt: ts(raw.archivedAt),
    // 过期是「到点不再注入」，正文留着；不主动改 status，方便她看到「这条过期了」。
    expiresAt: ts(raw.expiresAt) || null
  };
}

/**
 * 读库。不存在返回空库；损坏抛错——不能把「读不动」当「空库」写回去。
 */
export function loadSharedMemory(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
  const raw = JSON.parse(text);
  const store = emptyStore();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return store;
  const seen = new Set();
  for (const it of raw.items) {
    const n = normalizeItem(it);
    if (!n) continue;
    // 重复/缺失 id：补齐而不是丢掉这条内容。
    if (!n.id || seen.has(n.id)) n.id = null;
    else seen.add(n.id);
    store.items.push(n);
  }
  for (const it of store.items) {
    if (!it.id) it.id = makeId(seen);
    seen.add(it.id);
  }
  return store;
}

/** 原子写盘，权限 600（state/ 目录本身是 700）。 */
export function saveSharedMemory(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const items = (Array.isArray(store?.items) ? store.items : [])
    .filter((it) => it && typeof it === 'object' && cleanText(it.text) && normalizeScope(it.scope));
  const body = JSON.stringify({ version: SHARED_MEMORY_VERSION, items }, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function makeId(taken) {
  for (let i = 0; i < 100; i += 1) {
    const id = 'm' + crypto.randomBytes(3).toString('hex').slice(0, 5);
    if (!taken.has(id)) return id;
  }
  return 'm' + Date.now().toString(16).slice(-5);
}

function allIds(store) {
  return new Set((store?.items ?? []).map((it) => it.id).filter(Boolean));
}

function activeItems(store) {
  return (store?.items ?? []).filter((it) => it && it.status === 'active');
}

function isExpired(item, now) {
  return Boolean(item?.expiresAt) && now >= Number(item.expiresAt);
}

/**
 * 可见性判定 —— 整个模块唯一的权限口径。
 * 过期项、已遗忘项、已归档项一律不可读（正文仍留在库里，可恢复）。
 */
export function canRead(item, reader, now = Date.now()) {
  if (!item || typeof item !== 'object') return false;
  if (item.status !== 'active') return false;
  if (isExpired(item, now)) return false;
  const scope = normalizeScope(item.scope);
  if (!scope) return false;
  const kind = reader?.kind;
  if (scope === 'owner_private') return kind === 'owner';
  if (scope === 'shared') {
    if (kind === 'owner') return true;
    if (kind === 'group') {
      const list = Array.isArray(item.visibleGroups) ? item.visibleGroups : [];
      return list.includes(String(reader.id));
    }
    return false;
  }
  const gid = groupIdOfScope(scope);
  if (!gid) return false;
  return kind === 'group' && String(reader.id) === gid;
}

/**
 * 记一条摘要。
 *
 * dedupe：同 scope 同正文视为「又提起了这件事」，只刷新 lastMentionAt，
 * 不新增一条——否则「主人爱吃米饭」会被记成好几条。
 */
export function addItem(store, {
  text, scope, visibleGroups, importance, sourceRef, expiresAt, pinned, now = Date.now()
} = {}) {
  const t = cleanText(text);
  if (!t) throw new Error('text（要记什么）不能为空');
  const sc = normalizeScope(scope);
  if (!sc) throw new Error(`scope 只能是 shared / owner_private / group:<群号>（收到「${scope}」）`);

  if (!Array.isArray(store.items)) store.items = [];

  const dup = activeItems(store).find((it) => it.scope === sc && it.text === t);
  if (dup) {
    dup.lastMentionAt = now;
    dup.importance = Math.max(dup.importance, clampImportance(importance ?? dup.importance));
    if (sc === 'shared') {
      const merged = [...(dup.visibleGroups || [])];
      for (const g of cleanGroupList(visibleGroups)) if (!merged.includes(g)) merged.push(g);
      dup.visibleGroups = merged;
    }
    return { item: dup, created: false };
  }

  const item = {
    id: makeId(allIds(store)),
    text: t,
    scope: sc,
    visibleGroups: sc === 'shared' ? cleanGroupList(visibleGroups) : [],
    pinned: pinned === true,
    importance: clampImportance(importance),
    sourceRef: cleanSource(sourceRef) || null,
    status: 'active',
    createdAt: now,
    lastMentionAt: now,
    updatedAt: 0,
    forgottenAt: 0,
    archivedAt: 0,
    expiresAt: ts(expiresAt) || null
  };
  store.items.push(item);
  return { item, created: true };
}

function findItem(store, id) {
  const sid = cleanId(id);
  if (!sid) return null;
  return (store?.items ?? []).find((it) => it.id === sid) || null;
}

/**
 * 改一条。改正文时把旧正文留在 originalText（模糊是改写，不是删除）。
 * 不提供改 id / 改 status 的入口——status 只能走 forget / archive。
 */
export function updateItem(store, id, patch = {}, now = Date.now()) {
  const found = findItem(store, id);
  if (!found) return null;
  let changed = false;

  if (patch.text !== undefined && patch.text !== null) {
    const next = cleanText(patch.text);
    if (next && next !== found.text) {
      if (!found.originalText) found.originalText = found.text;
      found.text = next;
      changed = true;
    }
  }

  if (patch.scope !== undefined && patch.scope !== null && String(patch.scope).trim() !== '') {
    const sc = normalizeScope(patch.scope);
    if (!sc) throw new Error(`scope 只能是 shared / owner_private / group:<群号>（收到「${patch.scope}」）`);
    if (sc !== found.scope) {
      found.scope = sc;
      if (sc !== 'shared') found.visibleGroups = [];
      changed = true;
    }
  }

  if (patch.visibleGroups !== undefined) {
    // 只有 shared 项带着个列表；其他 scope 上没有意义，直接忽略。
    if (found.scope === 'shared') {
      const next = cleanGroupList(patch.visibleGroups);
      const prev = Array.isArray(found.visibleGroups) ? found.visibleGroups : [];
      if (next.length !== prev.length || next.some((g, i) => g !== prev[i])) {
        found.visibleGroups = next;
        changed = true;
      }
    }
  }

  if (patch.importance !== undefined && patch.importance !== null && String(patch.importance).trim() !== '') {
    const n = clampImportance(patch.importance);
    if (n !== found.importance) { found.importance = n; changed = true; }
  }

  if (patch.sourceRef !== undefined) {
    const s = cleanSource(patch.sourceRef) || null;
    if (s !== found.sourceRef) { found.sourceRef = s; changed = true; }
  }

  if (patch.expiresAt !== undefined) {
    const e = ts(patch.expiresAt) || null;
    if (e !== found.expiresAt) { found.expiresAt = e; changed = true; }
  }

  if (patch.lastMentionAt !== undefined) {
    const m = ts(patch.lastMentionAt);
    if (m !== found.lastMentionAt) { found.lastMentionAt = m; changed = true; }
  }

  if (changed) found.updatedAt = now;
  return { item: found, changed };
}

/**
 * 忘掉一条 —— 软删，正文留着。
 *
 * 主人约定（pinned）不许被旁路掉：这是作业里点名的红线，所以这里硬挡，
 * 要真删必须主人在场直接改文件。返回结构化结果而不是抛错，方便工具层把话说清楚。
 */
export function forgetItem(store, id, { now = Date.now() } = {}) {
  const found = findItem(store, id);
  if (!found) return { ok: false, reason: 'not-found', item: null };
  if (found.status === 'forgotten') return { ok: false, reason: 'already-forgotten', item: found };
  if (found.pinned) return { ok: false, reason: 'pinned', item: found };
  found.status = 'forgotten';
  found.forgottenAt = now;
  found.updatedAt = now;
  return { ok: true, reason: 'forgotten', item: found };
}

/** 归档（可恢复，比忘掉更轻），用于容量淘汰。 */
export function archiveItem(store, id, { now = Date.now() } = {}) {
  const found = findItem(store, id);
  if (!found) return null;
  if (found.status === 'archived') return found;
  found.status = 'archived';
  found.archivedAt = now;
  found.updatedAt = now;
  return found;
}

/**
 * 容量治理：清过期、清超量。pinned 永远不动。
 *
 * 淘汰顺序（测试固化）：先到期，再 importance 低的，再 lastMentionAt 老的。
 * 「最近提及优先」体现在最后一条 —— 最近刚被提起的事最不容易被挤掉。
 */
export function pruneStore(store, { max = MAX_ITEMS, maxArchived = MAX_ARCHIVED, now = Date.now() } = {}) {
  const removed = [];
  const list = store?.items ?? [];

  for (const it of list) {
    if (it.status !== 'active') continue;
    if (it.pinned) continue;
    if (isExpired(it, now)) {
      it.status = 'archived';
      it.archivedAt = now;
      removed.push({ id: it.id, reason: 'expired' });
    }
  }

  let active = list.filter((it) => it.status === 'active');
  const hardMax = Math.max(1, Math.floor(Number(max) || MAX_ITEMS));
  if (active.length > hardMax) {
    const evictable = active
      .filter((it) => !it.pinned)
      .sort((a, b) => {
        if (a.importance !== b.importance) return a.importance - b.importance;
        const am = Number(a.lastMentionAt) || Number(a.createdAt) || 0;
        const bm = Number(b.lastMentionAt) || Number(b.createdAt) || 0;
        return am - bm;
      });
    let over = active.length - hardMax;
    for (const it of evictable) {
      if (over <= 0) break;
      it.status = 'archived';
      it.archivedAt = now;
      removed.push({ id: it.id, reason: 'overflow' });
      over -= 1;
    }
    // 全是 pinned 兜不住上限时，宁可不删：约定比配额重要。
    active = list.filter((it) => it.status === 'active');
  }

  const archived = list.filter((it) => it.status === 'archived');
  const keepArchived = Math.max(0, Math.floor(Number(maxArchived) || MAX_ARCHIVED));
  if (archived.length > keepArchived) {
    archived
      .sort((a, b) => (Number(a.archivedAt) || 0) - (Number(b.archivedAt) || 0))
      .slice(0, archived.length - keepArchived)
      .forEach((it) => {
        const idx = list.indexOf(it);
        if (idx >= 0) list.splice(idx, 1);
        removed.push({ id: it.id, reason: 'archive-trim' });
      });
  }

  return { removed, activeCount: list.filter((it) => it.status === 'active').length };
}

/** 当前受众能看到的条目，按 importance、lastMentionAt 排。 */
export function listItems(store, { reader, now = Date.now() } = {}) {
  return activeItems(store)
    .filter((it) => canRead(it, reader, now))
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      const am = Number(a.lastMentionAt) || Number(a.createdAt) || 0;
      const bm = Number(b.lastMentionAt) || Number(b.createdAt) || 0;
      return bm - am;
    });
}

/**
 * 每轮注入的文本。硬限条数和字数——这是「注入容量封顶」那条通过条件的落点。
 * 只读当前受众能看的，且按 README 的口径：群聊里绝不出现 owner_private。
 */
export function formatForPrompt(store, {
  reader, max = INJECT_MAX_ITEMS, maxChars = INJECT_MAX_CHARS, now = Date.now()
} = {}) {
  const items = listItems(store, { reader, now });
  if (!items.length) return '';
  const picked = items.slice(0, Math.max(1, Math.floor(Number(max) || INJECT_MAX_ITEMS)));
  const lines = [];
  let used = 0;
  for (const it of picked) {
    const line = `- ${it.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const rest = items.length - lines.length;
  const tail = rest > 0 ? `\n（另外还记得 ${rest} 条，想翻就用 qq_shared_memory）` : '';
  return `【你还记得的事】\n${lines.join('\n')}${tail}`;
}

/** 少量统计，给控制台和工具层用。 */
export function statsOf(store, { now = Date.now() } = {}) {
  const list = store?.items ?? [];
  const active = list.filter((it) => it.status === 'active');
  const byScope = {};
  for (const it of active) {
    const key = groupIdOfScope(it.scope) ? `group:${groupIdOfScope(it.scope)}` : it.scope;
    byScope[key] = (byScope[key] || 0) + 1;
  }
  return {
    total: list.length,
    active: active.length,
    pinned: active.filter((it) => it.pinned).length,
    expired: active.filter((it) => isExpired(it, now)).length,
    visibleGroups: active.filter((it) => it.scope === 'shared' && (it.visibleGroups || []).length).length,
    forgotten: list.filter((it) => it.status === 'forgotten').length,
    archived: list.filter((it) => it.status === 'archived').length,
    byScope
  };
}
