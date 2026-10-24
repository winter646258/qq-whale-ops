#!/usr/bin/env node
// 阶段15：把 POST /api/voice/send（含 /api/send/voice 别名）搬进 voice 模块的 send.js。
//
// 幂等：先用 MARKER 判重，再决定插入还是删除。
// 顺序：先检查老 if 块在不在 → 在就删 → 注入 ctx → 写回 → node --check。
//
// 用法：
//   node scripts/patch-modules-stage15.mjs            # 应用
//   node scripts/patch-modules-stage15.mjs --dry-run  # 只看会改什么
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage15.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK_CTX = '// MARKER: modules-ctx-voice-send';

let source = fs.readFileSync(FILE, 'utf8');
const before = source;
const notes = [];

// ── 1. 删除老 if 块 ───────────────────────────────────────────────
// 起点是那句注释；终点是紧跟其后的 `          return;` 加 `        }`。
// 整段搬运，不做行内判断，避免把条件抽走一半。
const START_SENTINEL = "        // ── 语音发送（操作者通道：CLI / 控制台，凭 token）────────────────";
const HEAD_SENTINEL = "        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {";

function removeVoiceSendBlock(text) {
  const s = text.indexOf(START_SENTINEL);
  if (s < 0) {
    // 起点注释可能不存在（不同版本写法），退回到直接找 if 行。
    const h = text.indexOf(HEAD_SENTINEL);
    if (h < 0) return { text, removed: 0 };
    return cutFrom(text, h);
  }
  return cutFrom(text, s);
}

function cutFrom(text, start) {
  // 从 start 开始逐字符跟踪大括号深度，找到与 if 块配对的收尾位置。
  const braceStart = text.indexOf('{', text.indexOf("if (req.method === 'POST'", start));
  if (braceStart < 0) throw new Error('找不到 if 块起始大括号');
  let depth = 0;
  let i = braceStart;
  let inStr = null;
  let inTpl = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    const prev = text[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (inTpl) { if (c === '`' && prev !== '\\') inTpl = false; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  // 吃掉块尾的换行
  let end = i;
  while (text[end] === '\n') end += 1;
  const removedText = text.slice(start, end);
  const removed = removedText.split('\n').length;
  return { text: text.slice(0, start) + text.slice(end), removed };
}

if (source.includes(HEAD_SENTINEL)) {
  const res = removeVoiceSendBlock(source);
  source = res.text;
  notes.push(`删除老 if 块 ${res.removed} 行`);
} else {
  notes.push('老 if 块已不存在（幂等跳过）');
}

// ── 2. 注入 ctx（插在模块自建的函数之后，避开 TDZ）──────────────────
// 关键：这几个函数声明写在 voiceCfg() 之后（函数体里可见），
// 所以注入块可以摆在它们后面；反过来（摆在前面）会在对象字面量的值位置
// 立即求值，撞上 `Cannot access before initialization`。
const ANCHOR_FN = '  function voiceCfg() {';
if (!source.includes(MARK_CTX)) {
  const anchorAt = source.indexOf(ANCHOR_FN);
  if (anchorAt < 0) throw new Error('找不到 voiceCfg() 声明，无法定位注入点');
  // 找到 voiceCfg(){} 的收尾，把注入块摆在其后。
  // 注意不能自己再声明 resolveVoicePathForOperator —— main() 里已经有同名函数（L1998），
  // 重复声明会直接 SyntaxError。
  const closeIdx = findFnEnd(source, anchorAt);
  const block = `
  // MARKER: modules-ctx-voice-send
  // 阶段15：语音发送（操作者通道）用到的 main() 内函数。
  // 它们全部排在 voiceCfg() 之后（resolveVoicePathForOperator@L1998、
  // voiceBudget*@L2017、sendVoiceV2@L2045、verifyVoiceMessageSent@L2160、modeAllowed@L3265），
  // 所以注入块必须摆在 voiceCfg() 收尾之后：对象字面量的值位置会立即求值，
  // 摆前面就撞 TDZ。一律交箭头/闭包，不交快照值。
  Object.assign(moduleCtx, {
    voiceSendHelpers: {
      modeAllowed: (key, kind, id, cfgArg, modeArg) => modeAllowed(key, kind, id, cfgArg, modeArg),
      currentMode: () => currentMode,
      resolveVoicePathForOperator: (input) => resolveVoicePathForOperator(input),
      voiceBudgetCheck: (scopeKey, cfgV) => voiceBudgetCheck(scopeKey, cfgV),
      voiceBudgetCommit: (scopeKey, at) => voiceBudgetCommit(scopeKey, at),
      sendVoiceV2: (key, filePath, opts) => sendVoiceV2(key, filePath, opts),
      verifyVoiceMessageSent: (messageId) => verifyVoiceMessageSent(messageId),
      // send-voice-lib.js 的纯函数：顶层 import 进来的名字不在 moduleCtx 上，必须显式交。
      parseTargetKey: (value) => parseTargetKey(value),
      resolveAudioProcessing: (opts) => resolveAudioProcessing(opts),
    },
    appendActivity: (line) => appendActivity(line),
  });
`;
  source = source.slice(0, closeIdx) + block + source.slice(closeIdx);
  notes.push('注入 voiceSendHelpers / appendActivity');
}

// ── 3. 语法检查后落盘 ─────────────────────────────────────────────
function findFnEnd(text, fnStart) {
  const braceStart = text.indexOf('{', fnStart);
  let depth = 0;
  let i = braceStart;
  let inStr = null;
  for (; i < text.length; i += 1) {
    const c = text[i];
    const prev = text[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  // 吃掉收尾换行
  while (text[i] === '\n') i += 1;
  return i;
}

if (source === before) {
  console.log('无变化（已应用过）');
  for (const n of notes) console.log(`  · ${n}`);
  process.exit(0);
}

fs.writeFileSync(TMP, source, 'utf8');
try {
  execFileSync(process.execPath, ['--check', TMP], { stdio: 'pipe' });
} catch (error) {
  fs.unlinkSync(TMP);
  console.error('语法检查失败，未改动线上文件：');
  console.error(String(error.stderr || error.message));
  process.exit(1);
}
fs.unlinkSync(TMP);

const linesBefore = before.split('\n').length;
const linesAfter = source.split('\n').length;
for (const n of notes) console.log(`  · ${n}`);
console.log(`  · 行数 ${linesBefore} → ${linesAfter}`);

if (dryRun) {
  console.log('--dry-run：未写回');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const backup = `${FILE}.bak-stage15-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);
