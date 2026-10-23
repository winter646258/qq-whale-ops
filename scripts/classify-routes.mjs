#!/usr/bin/env node
/**
 * 阶段 2：把 114 条路由 if 按「业务族」归类，并算出每个族的真实依赖。
 *
 * 为什么先做这个而不是先写模块：
 *   模块的边界不能拍脑袋。`main()` 里 267 个函数是全互通的闭包，任何一条路由
 *   都可能顺着调用链摸到几十个别的东西。先量清楚「这个族用了哪些函数、那些函数
 *   又用了哪些状态」，才知道哪些族能干净切出来、哪些必须一起搬。
 *
 * 输出：
 *   · 每个族的行数（真实代码量，不是路由条数）
 *   · 该族直接调用的 main() 内函数 → 传递闭包 → 最终触碰的顶层状态声明
 *   · 「最容易先切」的族排序：依赖越少越靠前
 *
 * 用法：node scripts/classify-routes.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = '/opt/qq-bridge/src/bridge.js';
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

/** 用大括号配平截取从 startLine 起的 if 块（含到闭合的那一行）。 */
function ifBlockEnd(startIdx) {
  let depth = 0;
  let inStr = null;
  let inTpl = 0;
  let inLine = false;
  let inBlock = false;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    for (let p = 0; p < line.length; p += 1) {
      const ch = line[p];
      const nx = line[p + 1];
      if (inLine) break;
      if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; p += 1; } continue; }
      if (inStr) { if (ch === '\\') { p += 1; continue; } if (ch === inStr) inStr = null; continue; }
      if (inTpl > 0) { if (ch === '\\') { p += 1; continue; } if (ch === '`') inTpl -= 1; continue; }
      if (ch === '/' && nx === '/') { inLine = true; break; }
      if (ch === '/' && nx === '*') { inBlock = true; p += 1; continue; }
      if (ch === "'" || ch === '"') { inStr = ch; continue; }
      if (ch === '`') { inTpl += 1; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          // 同一边界可能还有后续的行，向前找到缩进回到 8 的 '}' 为止
          let end = i;
          while (end + 1 < lines.length && lines[end + 1].startsWith('        }')) end += 1;
          return end;
        }
      }
    }
    inLine = false;
  }
  return lines.length - 1;
}

// ── 1. 抽出全部路由（只取缩进 8 的，且路径来自 url.pathname）─────────────────
const routes = [];
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  if (!l.startsWith('        if (')) continue;
  const m = /url\.pathname\s*(===|\.startsWith\()\s*'([^']+)'/.exec(l);
  if (!m) continue;
  // 闸门里的前缀判断缩进也是 8，带 x-agent-token 条件的一律跳过
  if (l.includes("x-agent-token")) continue;
  const end = ifBlockEnd(i);
  routes.push({
    startLine: i + 1,
    endLine: end + 1,
    kind: m[1] === '===' ? 'exact' : 'prefix',
    path: m[2],
    method: /req\.method === 'GET'/.test(l) ? 'GET' : (/req\.method === 'POST'/.test(l) ? 'POST' : 'ANY'),
    bodyLines: end - i + 1,
    text: lines.slice(i, end + 1).join('\n'),
  });
}

// ── 2. main() 内函数清单 + 各自依赖（传递闭包）────────────────────────────────
const mainStart = lines.findIndex((l) => /^async function main\(\)/.test(l));
const mainEnd = (() => {
  for (let i = mainStart + 1; i < lines.length; i += 1) if (lines[i] === '}') return i;
  return lines.length;
})();

const fnDefs = new Map(); // name -> { startLine, endLine, text }
for (let i = mainStart + 1; i < mainEnd; i += 1) {
  const m = /^  (?:async )?function ([\w$]+)\s*\(/.exec(lines[i]);
  if (!m) continue;
  const end = ifBlockEnd(i);
  fnDefs.set(m[1], { startLine: i + 1, endLine: end + 1, text: lines.slice(i, end + 1).join('\n') });
}

/** 顶层 const/let 声明名（main 内缩进 2）。 */
const topDecls = new Set();
for (let i = mainStart + 1; i < mainEnd; i += 1) {
  // 只算真正的状态/句柄，不算解构出来的短名字和显而易见的局部常量。
  // 第一版把 `const api = ...`（某个 handler 里的局部变量）也算成顶层状态，
  // 导致「依赖总量」全是噪声。
  const m = /^  (?:const|let) ([\w$]{3,})\s*=/.exec(lines[i]);
  if (m) topDecls.add(m[1]);
}

const ALL_FN = [...fnDefs.keys()];
/** 一段文本里出现了哪些 main 内函数名。 */
function usedFns(text) {
  const hit = new Set();
  for (const name of ALL_FN) {
    // 排除定义行自身
    if (new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'm').test(text)) hit.add(name);
  }
  return hit;
}
/** 传递闭包。 */
function closure(seed) {
  const seen = new Set();
  const queue = [...seed];
  while (queue.length) {
    const n = queue.pop();
    if (seen.has(n) || !fnDefs.has(n)) continue;
    seen.add(n);
    for (const d of usedFns(fnDefs.get(n).text)) if (!seen.has(d)) queue.push(d);
  }
  return seen;
}
/** 一段文本 + 闭包触碰了哪些顶层状态。 */
function touchedState(text, fnSet) {
  const all = new Set();
  const scan = (t) => {
    for (const name of topDecls) {
      // 要求：不是属性访问、不是更长的标识符的一部分
      const re = new RegExp(`(^|[^\\w$.])${name}(?![\\w$])`, 'm');
      if (re.test(t)) all.add(name);
    }
  };
  scan(text);
  for (const f of fnSet) {
    const d = fnDefs.get(f);
    if (d) scan(d.text);
  }
  return all;
}

// ── 3. 归族 ──────────────────────────────────────────────────────────────────
function familyOf(p) {
  const s = p.replace(/^\/+|\/+$/g, '');
  if (!s) return 'root-page';
  const parts = s.split('/');
  if (parts[0] !== 'api') return `page:${parts[0]}`;
  const seg = parts[1] ?? '';
  // /api/send/*、/api/images/* 是「发消息」的一族；/api/socialV2/* 内部按子域再分
  if (seg === 'socialV2') {
    const sub = parts[2] ?? '';
    if (['config', 'activity', 'reset', 'states', 'state', 'wake', 'wake-config', 'prompt', 'status'].includes(sub)) return 'v2:core';
    if (/^(unread|recent|mark-read|wait|check-send|message-detail|my-recent|record-sent|active-members|forward-message|forward-media)/.test(sub)) return 'v2:messages';
    if (/^(send-|collect-sticker)/.test(sub)) return 'v2:outbound';
    if (/^(image|self-image|sticker-image|image-approval)/.test(sub)) return 'v2:image';
    if (/^(sticker-|voices|voice)/.test(sub)) return 'v2:sticker-voice';
    if (/^(memory|shared-memory|slang)/.test(sub)) return 'v2:memory';
    if (/^(mood|diary|share-signal|spotify|bili|qzone|tool-log|feedback)/.test(sub)) return 'v2:extras';
    return 'v2:misc';
  }
  return `api:${seg}`;
}

const fams = new Map();
for (const r of routes) {
  const f = familyOf(r.path);
  if (!fams.has(f)) fams.set(f, []);
  fams.get(f).push(r);
}

const report = [];
for (const [fam, rs] of fams) {
  const text = rs.map((r) => r.text).join('\n');
  const direct = usedFns(text);
  const all = closure(direct);
  const state = touchedState(text, all);
  report.push({
    family: fam,
    routes: rs.length,
    lines: rs.reduce((a, r) => a + r.bodyLines, 0),
    fyDirect: direct.size,
    fnClosure: all.size,
    state: [...state].sort(),
    paths: rs.map((r) => `${r.method} ${r.path}`).sort(),
  });
}
report.sort((a, b) => (a.fnClosure + a.state.length) - (b.fnClosure + b.state.length) || a.lines - b.lines);

const total = {
  routes: routes.length,
  lines: routes.reduce((a, r) => a + r.bodyLines, 0),
  mainFn: ALL_FN.length,
  topDecls: topDecls.size,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, report }, null, 1));
} else {
  console.log(`路由 ${total.routes} 条 / ${total.lines} 行；main 内函数 ${total.mainFn} 个、顶层状态 ${total.topDecls} 个`);
  console.log('');
  console.log('族'.padEnd(20), '路由', '代码行', '直接函数', '闭包', '状态', '  依赖总量');
  for (const r of report) {
    const score = r.fnClosure + r.state.length;
    console.log(
      r.family.padEnd(20),
      String(r.routes).padStart(4),
      String(r.lines).padStart(6),
      String(r.fyDirect).padStart(8),
      String(r.fnClosure).padStart(5),
      String(r.state.length).padStart(4),
      '  ' + score,
    );
  }
  console.log('');
  console.log('=== 最轻的 5 个族，各自触碰的状态 ===');
  for (const r of report.slice(0, 5)) {
    console.log(`\n[${r.family}] ${r.routes} 路由 / ${r.lines} 行 / 闭包 ${r.fnClosure}`);
    console.log('  路由:', r.paths.join('、'));
    console.log('  状态:', r.state.join('、') || '(无)');
  }
}
