// 阶段9：把表情库 AI 侧 5 条路由搬进 sticker 模块。
//
// 与阶段8 的区别（写在这里，免得下次又踩）：
//   这一族是**智能体通道**，鉴权走 agentTokenOk + v2SessionAllowed + v2ToolEnabled，
//   不等价于控制台的 rejectAgent。搬的时候必须逐条对齐，不能顺手换成控制台口径。
//
// 幂等；先 --check 再落盘；支持 --dry-run。
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
  console.error(`[stage9] ${message}`);
  process.exit(1);
}

// ── 1) 扩两个 helper 面 ─────────────────────────────────────────────────
// stickerHelpers 补 enabled / getStickerImageData / lastForcedSync（读+写）
// mediaHelpers 收拢图片体积/像素上限与 mime 嗅探（都是 main() 内的声明）
const PATCHES = [
  {
    tag: 'modules-ctx-stickers-ai',
    anchor: '  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护',
    insert: `  // MARKER: modules-ctx-stickers-ai
  // 阶段9：表情库 AI 工具面需要的句柄。
  //   lastForcedAgentStickerSync 是 main() 的 let（10 秒刷新节流要读写），交访问器；
  //   其余是声明在后面的函数/常量，只放在函数体里调用，不立即求值（TDZ）。
  // mediaHelpers 收的是图片体积/像素上限与 mime 嗅探，全部只读。
  Object.defineProperty(moduleCtx, 'mediaHelpers', {
    get: () => ({
      getImageDimensions,
      mimeFromBuffer,
      mimeFromUrl,
      maxMediaBytes: () => MAX_MEDIA_BYTES,
      maxMediaPixels: () => MAX_MEDIA_PIXELS,
    }),
    enumerable: true,
    configurable: true,
  });
  Object.assign(moduleCtx.stickerHelpers, {
    enabled: () => stickerEnabled(),
    getStickerImageData: (id) => getStickerImageData(id),
    lastForcedSync: () => lastForcedAgentStickerSync,
    setLastForcedSync: (value) => { lastForcedAgentStickerSync = value; },
  });
`,
  },
];

for (const { tag, anchor, insert } of PATCHES) {
  if (text.includes(`// MARKER: ${tag}`)) { marks.push(`跳过 ${tag}：已存在`); continue; }
  if (!text.includes(anchor)) die(`找不到锚点（${tag}）：${anchor.slice(0, 60)}`);
  const idx = text.indexOf(anchor);
  // 锚点是 `  let lastForcedAgentStickerSync = ...`：它就在 stage8 的
  // modules-ctx-stickers 块之后、stickerEnabled() 声明之前，是唯一合规落点。
  const eol = text.indexOf('\n', idx);
  text = text.slice(0, eol + 1) + insert + text.slice(eol + 1);
  marks.push(`插入 ${tag}`);
}

// ── 2) 删五条老路由 ─────────────────────────────────────────────────────
const targets = [
  ["if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {", 'GET /api/socialV2/sticker-list'],
  ["if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {", 'POST /api/socialV2/sticker-list'],
  ["if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {", 'GET /api/socialV2/sticker-image'],
  ["if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {", 'POST /api/socialV2/sticker-note'],
  ["if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {", 'POST /api/socialV2/sticker-remark'],
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
    if (indent.length !== 8) die(`${label} 缩进不是 8（实际 ${indent.length}），可能是闸门而不是路由，拒绝删除`);
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
  console.log('[stage9] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage9.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage9] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage9] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage9-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage9] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage9] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
