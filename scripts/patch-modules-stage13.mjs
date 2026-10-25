// 阶段13：把浏览器桥 /api/phone/* 三条业务路由 + OPTIONS 预检搬进 phone 模块。
//
// 这一族特殊在**它不在闸门之后**：
//   · 集中闸门里有 `phonePathExempt` 对 `/api/phone/` 放行（走 x-phone-token）；
//   · 委派点在闸门之后，所以模块里的 handler 必须自己做 phoneTokenOk。
//   · CORS 头要覆盖整个前缀 —— 模块里用「exact 优先 + prefix 兜底」实现。
//
// 删除范围是 7120~7165 这一整段（NOTES：`// MARKER: phone-bridge-routes` 注释也一并删掉）。
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
  console.error(`[stage13] ${message}`);
  process.exit(1);
}

// ── 1) 注入句柄 ─────────────────────────────────────────────────────────
// phoneBridge 是 main() 里 `new PhoneBridge(...)`（只建一次，交引用安全）；
// phoneTokenOk 是 main() 里的函数声明（同样安全，声明在注入点之后但只在
// 箭头函数体里被调用 ⇒ 不触发 TDZ）。
const HELPERS = `  // MARKER: modules-ctx-phone
  // 浏览器桥：phoneBridge 只建一次（交引用），phoneTokenOk 交闭包。
  Object.assign(moduleCtx, {
    phoneBridge,
    phoneTokenOk: (token) => phoneTokenOk(token),
  });
`;

const helperAnchor = '  const phoneBridge = new PhoneBridge({';
if (text.includes('// MARKER: modules-ctx-phone')) {
  marks.push('跳过 modules-ctx-phone：已存在');
} else {
  const start = text.indexOf(helperAnchor);
  if (start === -1) die('找不到 phoneBridge 构造');
  // 找该对象字面量的收尾 `  });`
  const closeIdx = text.indexOf('\n  });\n', start);
  if (closeIdx === -1) die('找不到 phoneBridge 构造的收尾');
  const insertAt = closeIdx + '\n  });\n'.length;
  text = text.slice(0, insertAt) + HELPERS + text.slice(insertAt);
  marks.push('插入 modules-ctx-phone');
}

// ── 2) 删老 if 块（从 MARKER: phone-bridge-routes 到 status 路由收尾）──
const startMarker = '        // MARKER: phone-bridge-routes';
const endSignature = "        if (url.pathname === '/api/phone/status' && req.method === 'GET') {";
if (!text.includes(endSignature)) {
  marks.push('跳过删除：已搬走');
} else {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => line.includes(startMarker));
  if (startIdx === -1) die('找不到 MARKER: phone-bridge-routes');
  const statusIdx = lines.findIndex((line) => line.includes(endSignature));
  if (statusIdx === -1) die('找不到 phone/status 路由');
  // status 块的收尾：从 statusIdx 往下，第一条正好是 8 空格的 `}`
  let endIdx = -1;
  for (let i = statusIdx + 1; i < lines.length; i += 1) {
    if (/^        }\s*$/.test(lines[i])) { endIdx = i; break; }
  }
  if (endIdx === -1) die('phone/status 块没有闭合');
  const removed = endIdx - startIdx + 1;
  if (removed < 40) die(`预期删除至少 40 行，实际只有 ${removed} 行，锚点可疑`);
  lines.splice(startIdx, removed);
  if (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
  text = lines.join('\n');
  marks.push(`删除 /api/phone/* 路由段：${removed} 行（原起始行 ${startIdx + 1}）`);
}

if (text === source) {
  console.log('[stage13] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage13.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage13] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage13] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage13-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage13] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage13] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
