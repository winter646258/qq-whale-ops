// 画像（长期认识）—— 纯逻辑模块。
//
// 作业给出的定位：
//   「长期认识。管"他平时在做什么、我怎么看他这个人"。」
//   不是待办清单，也不是用户画像（CRM 那种打标签喂推荐的东西）。
//
// 与「印象 memberImpressions」的区别（重要，别做重复系统）：
//   - memberImpressions 是**会话内的短标签**（话多、爱怼人），跟着会话状态走，按会话隔离。
//   - 画像 是**跨会话的、她自己写的、会随时间改口的判断**：这个人平时在做什么、
//     我和他处得怎么样。它属于角色，不属于某个群。
//
// 三条原则同样适用（作业里说「比功能本身重要」）：
//   一、记不记、糊不糊、升不升，都归角色自己 —— 本模块不写任何「观察 N 次自动升级」的规则。
//   二、模糊是改写，不是删除 —— 改观时旧判断进 originalText。
//   三、注入要分层 —— 只注入「核心几条 + 数量」，别把整本相册灌进上下文。
//
// 数据结构刻意保持「像人记的」而不是「像表」：
//   { id, subject, facet, text, originalText, blurred, weight, createdAt, updatedAt }
//   facet 只给三个粗粒度的面：在做什么（doing）/ 怎么看他（view）/ 处得怎么样（bond）
//   weight 1~9：她自己觉得这条有多重要。不自动涨，不自动跌。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FACETS = ['doing', 'view', 'bond'];
const FACET_SET = new Set(FACETS);
const FACET_ALIAS = {
  在做什么: 'doing', 做什么: 'doing', doing: 'doing', 近况: 'doing', 日常: 'doing',
  怎么看他: 'view', 看法: 'view', view: 'view', 印象: 'view', 人: 'view',
  处得怎么样: 'bond', 关系: 'bond', bond: 'bond', 感情: 'bond'
};

export const MAX_SUBJECTS = 50;
export const MAX_FACETS_PER_SUBJECT = 12;
export const MAX_TEXT_CHARS = 160;
export const MAX_ORIGINAL_CHARS = 240;
export const MAX_WEIGHT = 9;

/** 每轮注入：每人最多几条明细（多的只报数量）。 */
export const INJECT_FACETS_PER_SUBJECT = 3;
export const INJECT_MAX_SUBJECTS = 5;

export function normalizeFacet(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return 'view';
  if (FACET_SET.has(raw)) return raw;
  const hit = FACET_ALIAS[raw];
  if (hit) return hit;
  if (/doing|在做什么|做什么|近况|日常/.test(raw)) return 'doing';
  if (/bond|关系|处|感情/.test(raw)) return 'bond';
  if (/view|看|人/.test(raw)) return 'view';
  return null;
}

function emptyStore() {
  return { version: 1, subjects: {} };
}

function cleanSubjectName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (['__proto__', 'constructor', 'prototype'].includes(s)) return '';
  return s.slice(0, 40);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const text = String(raw.text ?? '').trim().slice(0, MAX_TEXT_CHARS);
  if (!id || !text) return null;
  const facet = FACET_SET.has(raw.facet) ? raw.facet : 'view';
  return {
    id,
    facet,
    text,
    originalText: String(raw.originalText ?? '').trim().slice(0, MAX_ORIGINAL_CHARS) || null,
    blurred: raw.blurred === true,
    weight: Math.min(MAX_WEIGHT, Math.max(1, Math.round(Number(raw.weight) || 1))),
    createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0
  };
}

/**
 * 读画像库。不存在返回空库；损坏抛错（不能把「读不动」当「空库」写回去）。
 */
export function loadPortrait(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
  const raw = JSON.parse(text);
  const store = emptyStore();
  if (!raw || typeof raw !== 'object' || !raw.subjects || typeof raw.subjects !== 'object') return store;
  for (const [name, list] of Object.entries(raw.subjects)) {
    const subject = cleanSubjectName(name);
    if (!subject) continue;
    if (!Array.isArray(list)) continue;
    const items = [];
    for (const it of list) {
      const n = normalizeItem(it);
      if (n) items.push(n);
    }
    if (items.length) store.subjects[subject] = items.slice(-MAX_FACETS_PER_SUBJECT);
  }
  return store;
}

/** 原子写盘，权限 600。 */
export function savePortrait(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const subjects = {};
  for (const [name, list] of Object.entries(store?.subjects ?? {})) {
    const subject = cleanSubjectName(name);
    if (!subject || !Array.isArray(list)) continue;
    subjects[subject] = list;
  }
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, subjects }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function makeId(taken) {
  for (let i = 0; i < 100; i += 1) {
    const id = 'p' + crypto.randomBytes(3).toString('hex').slice(0, 5);
    if (!taken.has(id)) return id;
  }
  return 'p' + Date.now().toString(16).slice(-5);
}

function allIds(store) {
  const set = new Set();
  for (const list of Object.values(store.subjects ?? {})) {
    for (const it of list) set.add(it.id);
  }
  return set;
}

/** 记一条对她（他）的认识。 */
export function addPortrait(store, { subject, facet, text, weight, now = Date.now() } = {}) {
  const name = cleanSubjectName(subject);
  if (!name) throw new Error('subject（这是说谁）不能为空');
  const f = normalizeFacet(facet);
  if (!f) throw new Error(`facet 只能是 doing/view/bond（收到「${facet}」）`);
  const t = String(text ?? '').trim().slice(0, MAX_TEXT_CHARS);
  if (!t) throw new Error('内容不能为空');

  if (!store.subjects) store.subjects = {};
  const list = store.subjects[name] ?? [];
  if (list.length >= MAX_FACETS_PER_SUBJECT) {
    throw new Error(`${name} 的画像已经 ${MAX_FACETS_PER_SUBJECT} 条了，先合并或删掉几条`);
  }
  const subjectsCount = Object.keys(store.subjects).length;
  if (!store.subjects[name] && subjectsCount >= MAX_SUBJECTS) {
    throw new Error(`画像库已记录 ${MAX_SUBJECTS} 个人，先清理一些`);
  }

  const item = {
    id: makeId(allIds(store)),
    facet: f,
    text: t,
    originalText: null,
    blurred: false,
    weight: Math.min(MAX_WEIGHT, Math.max(1, Math.round(Number(weight) || 1))),
    createdAt: now,
    updatedAt: 0
  };
  store.subjects[name] = [...list, item];
  return item;
}

/**
 * 改观（不是删）。
 * 改 text ⇒ 旧判断进 originalText、blurred=true。
 * weight 是绝对值，她自己决定涨还是跌。
 */
export function updatePortrait(store, id, patch = {}, now = Date.now()) {
  const sid = String(id ?? '').trim();
  let found = null;
  let owner = null;
  for (const [name, list] of Object.entries(store.subjects ?? {})) {
    const it = list.find((x) => x.id === sid);
    if (it) { found = it; owner = name; break; }
  }
  if (!found) return null;

  let changed = false;

  if (patch.text !== undefined && patch.text !== null && String(patch.text).trim() !== '') {
    const next = String(patch.text).trim().slice(0, MAX_TEXT_CHARS);
    if (next !== found.text) {
      if (!found.originalText) found.originalText = found.text.slice(0, MAX_ORIGINAL_CHARS);
      found.text = next;
      found.blurred = true;
      changed = true;
    }
  }

  if (patch.facet !== undefined && patch.facet !== null && String(patch.facet).trim() !== '') {
    const f = normalizeFacet(patch.facet);
    if (!f) throw new Error(`facet 只能是 doing/view/bond（收到「${patch.facet}」）`);
    if (f !== found.facet) { found.facet = f; changed = true; }
  }

  if (patch.weight !== undefined && patch.weight !== null && String(patch.weight).trim() !== '') {
    const w = Math.min(MAX_WEIGHT, Math.max(1, Math.round(Number(patch.weight) || 1)));
    if (w !== found.weight) { found.weight = w; changed = true; }
  }

  if (patch.blurred !== undefined && typeof patch.blurred === 'boolean') {
    if (found.blurred !== patch.blurred) { found.blurred = patch.blurred; changed = true; }
  }

  // 换人（把这条挪到另一个 subject 名下）
  if (patch.subject !== undefined && patch.subject !== null && String(patch.subject).trim() !== '') {
    const target = cleanSubjectName(patch.subject);
    if (!target) throw new Error('非法的 subject');
    if (target !== owner) {
      store.subjects[owner] = store.subjects[owner].filter((x) => x.id !== sid);
      if (!store.subjects[owner].length) delete store.subjects[owner];
      store.subjects[target] = [...(store.subjects[target] ?? []), found];
      changed = true;
    }
  }

  if (changed) found.updatedAt = now;
  return { item: found, subject: patch.subject ? cleanSubjectName(patch.subject) : owner, changed };
}

export function removePortrait(store, id) {
  const sid = String(id ?? '').trim();
  for (const [name, list] of Object.entries(store.subjects ?? {})) {
    const idx = list.findIndex((x) => x.id === sid);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (!list.length) delete store.subjects[name];
      return true;
    }
  }
  return false;
}

export function listSubjects(store) {
  return Object.entries(store?.subjects ?? {}).map(([name, list]) => ({
    subject: name,
    count: list.length,
    topWeight: list.reduce((m, it) => Math.max(m, it.weight), 0),
    latestAt: list.reduce((m, it) => Math.max(m, it.updatedAt || it.createdAt), 0)
  })).sort((a, b) => b.topWeight - a.topWeight || b.latestAt - a.latestAt);
}

/** 看某个人的画像；不传 subject 看到全部（按权重排）。 */
export function queryPortrait(store, { subject, facet } = {}) {
  const f = facet ? normalizeFacet(facet) : null;
  if (facet && !f) throw new Error(`facet 只能是 doing/view/bond（收到「${facet}」）`);
  const name = subject ? cleanSubjectName(subject) : '';
  if (subject && !name) throw new Error('非法的 subject');

  const out = [];
  for (const [subj, list] of Object.entries(store?.subjects ?? {})) {
    if (name && subj !== name) continue;
    const items = list.filter((it) => (f ? it.facet === f : true));
    if (!items.length) continue;
    out.push({ subject: subj, items: [...items].sort((a, b) => b.weight - a.weight || a.createdAt - b.createdAt) });
  }
  out.sort((a, b) => {
    const aw = a.items.reduce((m, it) => Math.max(m, it.weight), 0);
    const bw = b.items.reduce((m, it) => Math.max(m, it.weight), 0);
    return bw - aw;
  });
  return { subjects: out, totalSubjects: out.length, totalItems: out.reduce((n, s) => n + s.items.length, 0) };
}

/**
 * 每轮注入的画像文本（分层：只给核心几条 + 数量）。
 * 刻意不塞全：塞满的话每轮都在烧上下文，而且角色反而看不进去。
 */
export function formatPortraitForPrompt(store, { maxSubjects = INJECT_MAX_SUBJECTS, maxFacets = INJECT_FACETS_PER_SUBJECT } = {}) {
  const all = listSubjects(store);
  if (!all.length) return '';

  const picked = all.slice(0, maxSubjects);
  const lines = [];
  for (const meta of picked) {
    const list = [...(store.subjects[meta.subject] ?? [])].sort((a, b) => b.weight - a.weight || a.createdAt - b.createdAt);
    const shown = list.slice(0, maxFacets);
    const rest = list.length - shown.length;
    const parts = shown.map((it) => it.text);
    lines.push(`- ${meta.subject}：${parts.join('；')}${rest > 0 ? `（还有 ${rest} 条）` : ''}`);
  }
  const restSubjects = all.length - picked.length;
  const tail = restSubjects > 0 ? `\n（另外还记着 ${restSubjects} 个人，想看就翻一下）` : '';
  return `【你对他们这些人的长期认识】\n${lines.join('\n')}${tail}`;
}

/** 管理员视角：翻出被改观前的原文。 */
export function revealOriginal(store, id) {
  const sid = String(id ?? '').trim();
  for (const [name, list] of Object.entries(store?.subjects ?? {})) {
    const it = list.find((x) => x.id === sid);
    if (it) return { subject: name, id: it.id, text: it.text, originalText: it.originalText, blurred: it.blurred };
  }
  return null;
}
