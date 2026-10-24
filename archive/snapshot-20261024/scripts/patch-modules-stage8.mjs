// 阶段8：把表情库管理 4 条路由（/api/stickers*）搬进 sticker-console 模块。
// 幂等：已打过就跳过。先 node --check 再落盘。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/opt/qq-bridge';
const TARGET = path.join(ROOT, 'src/bridge.js');
const dryRun = process.argv.includes('--dry-run');

const source = fs.readFileSync(TARGET, 'utf8');
let text = source;
const marks = [];

function die(message) {
  console.error(`[stage8] ${message}`);
  process.exit(1);
}

function once(tag, fn) {
  if (text.includes(`// MARKER: ${tag}`)) { marks.push(`跳过 ${tag}：已存在`); return; }
  const before = text.length;
  text = fn(text);
  if (text.length === before) die(`插入 ${tag} 失败：锚点未命中`);
  marks.push(`插入 ${tag}：+${text.length - before} 字符`);
}

// ── 1) 注入 stickerHelpers ───────────────────────────────────────────────
// stickerEntries / stickerSyncedAt 是 `let` 且会被整体重新赋值，必须交访问器。
const HELPERS = `  // MARKER: modules-ctx-stickers
  // 表情库：stickerEntries / stickerSyncedAt 会被 syncStickerLibrary 整体换成新数组，
  // 所以只交访问器；三个改动函数是 main() 内的声明，包一层即可保持原闭包。
  Object.assign(moduleCtx, {
    stickerHelpers: {
      entries: () => stickerEntries,
      syncedAt: () => stickerSyncedAt,
      syncStickerLibrary,
      formatStickerList,
      applyStickerNoteV2,
      setStickerRemarkV2,
    },
  });
`;

once('modules-ctx-stickers', (t) => {
  const anchor = '  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）';
  if (!t.includes(anchor)) die('找不到 stickerSyncedAt 声明');
  const idx = t.indexOf(anchor);
  const eol = t.indexOf('\n', idx);
  const after = t.slice(0, eol + 1) + HELPERS + t.slice(eol + 1);
  return after;
});

// ── 2) 删四条老路由 ─────────────────────────────────────────────────────
const targets = [
  ["if (req.method === 'GET' && url.pathname === '/api/stickers') {", '/api/stickers'],
  ["if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {", '/api/stickers/sync'],
  ["if (req.method === 'POST' && url.pathname === '/api/stickers/note') {", '/api/stickers/note'],
  ["if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {", '/api/stickers/remark'],
];

const pending = [];
for (const [signature, label] of targets) {
  if (!text.includes(signature)) { marks.push(`跳过删除 ${label}：已搬走`); continue; }
  pending.push({ signature, label });
}
if (pending.length) {
  const lines = text.split('\n');
  const ranges = [];
  for (const { signature, label } of pending) {
    const startIdx = lines.findIndex((line) => line.includes(signature));
    if (startIdx === -1) die(`找不到待删路由块：${label}`);
    const indent = lines[startIdx].match(/^\s*/)[0];
    const closeRe = new RegExp(`^${indent}}\\s*$`);
    let endIdx = -1;
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      if (closeRe.test(lines[i])) { endIdx = i; break; }
    }
    if (endIdx === -1) die(`待删路由块没有闭合：${label}`);
    ranges.push({ label, startIdx, endIdx });
  }
  ranges.sort((a, b) => b.startIdx - a.startIdx);
  for (const { label, startIdx, endIdx } of ranges) {
    const removed = endIdx - startIdx + 1;
    lines.splice(startIdx, removed);
    if (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
    marks.push(`删除 ${label}：${removed} 行（原起始行 ${startIdx + 1}）`);
  }
  text = lines.join('\n');
}

if (text === source) {
  console.log('[stage8] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage8.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage8] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage8] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage8-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage8] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage8] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
