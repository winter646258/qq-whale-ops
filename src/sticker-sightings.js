// 表情包「出场记录」——阶段 1 只观测，不做任何行为改变。
//
// 目的：先搞清楚群里到底有哪些图在反复出现，再决定要不要推荐收藏。
// 在这之前所有阈值（3 次？5 次？）都只能拍脑袋。
//
// 指纹策略：QQ 图片消息的 media[].file 形如 `81B4C2C7E6C14EA0E11441028FBB2563.jpg`，
// 前 32 位十六进制就是这张图的 MD5。同一张图重发时 MD5 不变（实测样本里
// `BD6EB43B9A241CF37B945FCF2F0CFCC6.jpg` 出现过两次、file 名完全一致），
// 所以这里直接用 MD5 做去重，零依赖、零解码成本。
// 只有当「同一张图被转码/重新上传导致 MD5 变了」成为实际问题时，
// 才需要补 pHash（服务器没有 ffmpeg/ImageMagick，但有 Python+PIL，可离线批算）。
//
// 这个模块只写 state/sticker-sightings.json，不碰表情库、不发消息、不改提示词。

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'sticker-sightings.json';
const FLUSH_MS = 60_000;
const MAX_CONTEXTS = 3;
const CONTEXT_CHARS = 40;

let storePath = '';
let items = new Map();   // hash -> { hash, count, firstSeen, lastSeen, url, sampleKey, contexts[] }
let dirty = false;
let timer = null;
let enabled = true;
let maxItems = 500;
let ttlDays = 30;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function prune() {
  const cutoff = Date.now() - ttlDays * 86_400_000;
  for (const [hash, item] of items) {
    if ((item.lastSeen || 0) < cutoff) items.delete(hash);
  }
  if (items.size <= maxItems) return;
  // 超上限时按「最久没出现」淘汰，保住正在流行的图
  const sorted = [...items.values()].sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  const drop = sorted.slice(0, items.size - maxItems);
  for (const item of drop) items.delete(item.hash);
}

/** 从一条消息的 media 数组里取出所有可用于去重的图片 MD5。 */
export function mediaHashes(media) {
  if (!Array.isArray(media)) return [];
  const out = [];
  for (const item of media) {
    if (!item || typeof item !== 'object') continue;
    if (String(item.kind || '') !== 'image') continue;
    const file = String(item.file || '');
    const m = /^([0-9A-Fa-f]{32})\./.exec(file);
    let hash = m ? m[1].toUpperCase() : '';
    if (!hash) {
      const md5 = String(item.md5 || '');
      if (/^[0-9A-Fa-f]{32}$/.test(md5)) hash = md5.toUpperCase();
    }
    if (hash) out.push({ hash, url: String(item.url || '') });
  }
  return out;
}

/** 启动时装载一次。返回已记录的条目数，方便启动日志打一行。 */
export function initSightings(stateDir, options = {}) {
  storePath = path.join(stateDir, FILE_NAME);
  enabled = options.enabled !== false;
  maxItems = Math.max(50, Number(options.max) || 500);
  ttlDays = Math.max(1, Number(options.ttlDays) || 30);
  const loaded = readJson(storePath, null);
  items = new Map();
  if (loaded && Array.isArray(loaded.items)) {
    for (const raw of loaded.items) {
      if (!raw || typeof raw !== 'object' || !raw.hash) continue;
      items.set(String(raw.hash), {
        hash: String(raw.hash),
        count: Math.max(1, Number(raw.count) || 1),
        firstSeen: Number(raw.firstSeen) || 0,
        lastSeen: Number(raw.lastSeen) || 0,
        url: String(raw.url || ''),
        sampleKey: String(raw.sampleKey || ''),
        contexts: Array.isArray(raw.contexts) ? raw.contexts.slice(-MAX_CONTEXTS) : [],
      });
    }
  }
  if (!timer) {
    timer = setInterval(flushSightingsNow, FLUSH_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return items.size;
}

/**
 * 记录一条消息里所有图片的出场。只更新内存，定时落盘。
 * @param {string} key      会话键，group:xxx / private:xxx
 * @param {Array}  media    消息的 media 数组
 * @param {object} meta     { sender, text, messageId, time }
 * @returns {number} 本次新记的图片张数（用于日志，不用于业务）
 */
export function recordSightings(key, media, meta = {}) {
  if (!enabled || !storePath) return 0;
  const hashes = mediaHashes(media);
  if (!hashes.length) return 0;
  const now = Number(meta.time) || Date.now();
  const text = clip(meta.text, CONTEXT_CHARS);
  const who = clip(meta.sender, 20);
  let touched = 0;
  for (const { hash, url } of hashes) {
    const prev = items.get(hash);
    if (prev) {
      prev.count += 1;
      prev.lastSeen = now;
      if (url && !prev.url) prev.url = url;
      if (text && !prev.contexts.includes(text)) {
        prev.contexts.push(who ? `${who}：${text}` : text);
        if (prev.contexts.length > MAX_CONTEXTS) prev.contexts = prev.contexts.slice(-MAX_CONTEXTS);
      }
    } else {
      items.set(hash, {
        hash,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        url: url || '',
        sampleKey: String(key || ''),
        contexts: text ? [who ? `${who}：${text}` : text] : [],
      });
    }
    touched += 1;
  }
  if (touched) dirty = true;
  return touched;
}

/** 立刻落盘。定时器会调它，收尾时也手动调一次。 */
export function flushSightingsNow() {
  if (!dirty || !storePath) return false;
  prune();
  const payload = { version: 1, updatedAt: Date.now(), items: [...items.values()] };
  const tmp = `${storePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** 直接读文件，给控制台接口用（不依赖进程内缓存）。 */
export function readSightings(stateDir, options = {}) {
  const file = path.join(stateDir, FILE_NAME);
  const data = readJson(file, null);
  const list = data && Array.isArray(data.items) ? data.items : [];
  const minCount = Math.max(1, Number(options.minCount) || 1);
  const rows = list
    .filter((i) => i && i.hash && (Number(i.count) || 0) >= minCount)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
  return {
    updatedAt: Number(data && data.updatedAt) || 0,
    total: list.length,
    matched: rows.length,
    items: rows.map((i) => ({
      hash: i.hash,
      count: Number(i.count) || 0,
      firstSeen: Number(i.firstSeen) || 0,
      lastSeen: Number(i.lastSeen) || 0,
      url: String(i.url || ''),
      sampleKey: String(i.sampleKey || ''),
      contexts: Array.isArray(i.contexts) ? i.contexts : [],
    })),
  };
}
