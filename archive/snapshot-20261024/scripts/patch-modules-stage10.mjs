// 阶段10：把 GET /api/socialV2/voices（别名 /api/voice/list）搬进 voice 模块。
//
// 这一族只有一条 if，但**挂两个路径**、**双通道鉴权**，搬的时候要注意：
//   - 模块侧必须是两条 exact 路由指向同一个 handler（不是一条 prefix）。
//   - 老 if 的签名是 `req.method === 'GET' && (A || B)`，删除时的匹配串要带上括号。
//   - 它比邻 /api/socialV2/ 前缀，迁走后要确认前缀闸门不受影响。
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
  console.error(`[stage10] ${message}`);
  process.exit(1);
}

// ── 1) 注入 voiceCfg + voiceHelpers ──────────────────────────────────────
// voiceCfg 是 main() 内声明在 L1834 的函数；voiceHelpers 收的是
// send-voice-lib.js 的几个顶层 import（纯函数）和 path —— 全部交引用/包一层即可。
const HELPERS = `  // MARKER: modules-ctx-voice
  // 语音库列表：voiceCfg 是 main() 内的函数（交闭包，避开 TDZ）；
  // voiceHelpers 全是顶层 import 的纯函数，直接交引用。
  Object.assign(moduleCtx, {
    voiceCfg: () => voiceCfg(),
    voiceHelpers: {
      path,
      listAudioFiles: (dir) => listAudioFiles(dir),
      inspectAudio: (file, opts) => inspectAudio(file, opts),
      describeAudio: (info) => describeAudio(info),
    },
  });
`;

const helperAnchor = '  function voiceCfg() {';
if (text.includes('// MARKER: modules-ctx-voice')) {
  marks.push('跳过 modules-ctx-voice：已存在');
} else {
  if (!text.includes(helperAnchor)) die('找不到 voiceCfg 声明');
  const idx = text.indexOf(helperAnchor);
  text = text.slice(0, idx) + HELPERS + text.slice(idx);
  marks.push('插入 modules-ctx-voice');
}

// ── 2) 删老 if 块 ───────────────────────────────────────────────────────
const signature = "if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {";
if (!text.includes(signature)) {
  marks.push('跳过删除：已搬走');
} else {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => line.includes(signature));
  if (startIdx === -1) die('找不到待删路由');
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
  marks.push(`删除 voices 路由：${removed} 行（原起始行 ${startIdx + 1}）`);
}

if (text === source) {
  console.log('[stage10] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage10.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage10] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage10] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage10-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage10] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage10] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
