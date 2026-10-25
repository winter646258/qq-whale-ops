// 阶段11：把 GET /api/status 搬进 status 模块。
//
// 这条路由有几个特殊之处，补丁必须照着来：
//   - 它是 agent 白名单里**唯一**的业务 GET，搬走后模块内不能 rejectAgent，
//     否则群里 AI 的模式探测会从 200 变 403（这是行为回归）。
//   - 它有两个分支（智能体受限视图 / 操作者完整视图），字段集完全不同，注释说明不能丢。
//   - 依赖里有 4 个「会被重新赋值的 let」：dshReady / closedAgentPreset /
//     currentMode（还有 socialV2 是 const 对象但字段会被改写）⇒ 全部交访问器，不能交快照。
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
  console.error(`[stage11] ${message}`);
  process.exit(1);
}

// ── 1) 注入句柄 ─────────────────────────────────────────────────────────
const HELPERS = `  // MARKER: modules-ctx-status
  // /api/status 的依赖：前五个是「会被重新赋值 / 字段会被就地改写」的状态，
  // 一律交访问器；readActivityTail 是顶层函数目录里的纯读函数，直接交引用。
  Object.assign(moduleCtx, {
    currentMode: () => currentMode,
    dshReady: () => dshReady,
    closedAgentPreset: () => closedAgentPreset,
    socialV2: () => socialV2,
    readActivityTail: (n) => readActivityTail(n),
  });
`;

const helperAnchor = '  let dshReady = false;';
if (text.includes('// MARKER: modules-ctx-status')) {
  marks.push('跳过 modules-ctx-status：已存在');
} else {
  if (!text.includes(helperAnchor)) die('找不到 dshReady 声明');
  const idx = text.indexOf(helperAnchor);
  const lineEnd = text.indexOf('\n', idx) + 1;
  text = text.slice(0, lineEnd) + HELPERS + text.slice(lineEnd);
  marks.push('插入 modules-ctx-status');
}

// ── 2) 删老 if 块（精确匹配 GET /api/status，缩进 8）──────────────────
const signature = "if (req.method === 'GET' && url.pathname === '/api/status') {";
const occurrences = text.split(signature).length - 1;
if (occurrences === 0) {
  marks.push('跳过删除：已搬走');
} else if (occurrences > 1) {
  die(`签名匹配到 ${occurrences} 处，不敢动`);
} else {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => line.includes(signature));
  const indent = lines[startIdx].match(/^\s*/)[0];
  if (indent.length !== 8) die(`缩进不是 8（实际 ${indent.length}），疑似闸门，拒绝删除`);
  const closeRe = new RegExp(`^${indent}}\\s*$`);
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (closeRe.test(lines[i])) { endIdx = i; break; }
  }
  if (endIdx === -1) die('待删路由块没有闭合');
  const removed = endIdx - startIdx + 1;
  lines.splice(startIdx, removed);
  if (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
  text = lines.join('\n');
  marks.push(`删除 /api/status 路由：${removed} 行（原起始行 ${startIdx + 1}）`);
}

if (text === source) {
  console.log('[stage11] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage11.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage11] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage11] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage11-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage11] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage11] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
