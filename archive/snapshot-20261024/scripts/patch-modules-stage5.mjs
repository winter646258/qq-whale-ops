// 阶段5：仿真提示词管理 4 条路由搬进模块（api:preset）
//
// 幂等。做的事：
//   1. 注入 presetHelpers（bridge.js 顶层 preset 工具族 + main() 内 resolvePresetName）
//   2. 删掉老 if 链里的 4 条路由（GET/POST sim-prompt、GET backups、POST restore）
//
// 坑（踩过 / 事先查清）：
//   - resolvePresetName 是 main() 内闭包，读 dshPresetIds / dshDefaultPreset 两个 let，
//     且这两者会被整体重新赋值 ⇒ 交箭头函数现取，不能交快照。
//   - presetHelpers 其余成员都是顶层纯函数/常量，注入点放哪都不涉及 TDZ。
import fs from 'node:fs';

const FILE = process.env.BRIDGE_FILE || '/opt/qq-bridge/src/bridge.js';
const DRY = process.argv.includes('--dry-run');

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const before = src.split('\n').length;

// ── 1. 注入 presetHelpers ─────────────────────────────────────────
const HELPER_MARKER = '  // MARKER: modules-ctx-preset\n';
if (src.includes(HELPER_MARKER)) {
  console.log('· 已有 presetHelpers，跳过');
} else {
  const anchor = '  // MARKER: modules-ctx-api\n';
  if (!src.includes(anchor)) die('找不到 // MARKER: modules-ctx-api 锚点');
  const block = `${HELPER_MARKER}  // 仿真提示词管理：这些工具函数都是 bridge.js 顶层的纯文件操作，
  // 只有 resolvePresetName 在 main() 内（它依赖 dshPresetIds / dshDefaultPreset
  // 两个会被整体重新赋值的 let），所以用箭头函数现取，别交快照值。
  Object.assign(moduleCtx, {
    presetHelpers: {
      fs,
      path,
      names: PRESET_NAMES,
      backupDir: PRESET_BACKUP_DIR,
      sourceYaml: presetSourceYaml,
      installedYaml: installedPresetYaml,
      readPromptText: readPresetPromptText,
      backupFile: backupPresetFile,
      listBackups: listPresetBackups,
      status: presetStatus,
      atomicWriteText,
      resolveName: (name) => resolvePresetName(name),
      extractPrefix: extractPresetPrefix,
      promptWarnings: presetPromptWarnings,
      promptBlockers: presetPromptBlockers,
      renderPromptYaml: renderPresetPromptYaml,
    },
  });
`;
  src = src.replace(anchor, block + anchor);
  console.log('· 注入 presetHelpers');
}

// ── 2. 删老 if 链里的路由块 ───────────────────────────────────────
/**
 * 定位包含 needle 的那条 `        if (` 块，按大括号配平整块删掉（含后面的空行）。
 * @returns {boolean} 是否删掉了一个块
 */
function cutRouteBlock(needle) {
  const at = src.indexOf(needle);
  if (at < 0) return false;
  const startMarker = '        if (';
  const blockStart = src.lastIndexOf(startMarker, at);
  if (blockStart < 0) die(`路由定位异常：${needle}`);
  let depth = 0;
  let end = -1;
  for (let i = blockStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) die(`if 块配平失败：${needle}`);
  while (src[end] === '\n' || src[end] === '\r') end += 1;
  const lineNo = src.slice(0, blockStart).split('\n').length;
  const lines = src.slice(blockStart, end).split('\n').length - 1;
  src = src.slice(0, blockStart) + src.slice(end);
  console.log(`· 删除 ${needle}（${lines} 行，原 L${lineNo}）`);
  return true;
}

// 先删更长路径，避免 needle 命中前缀把别的块截走
for (const needle of [
  "url.pathname === '/api/preset/sim-prompt/backups'",
  "url.pathname === '/api/preset/sim-prompt/restore'",
]) {
  cutRouteBlock(needle);
}
// 裸 sim-prompt 有 GET + POST 两块
let bare = 0;
while (cutRouteBlock("url.pathname === '/api/preset/sim-prompt'")) {
  bare += 1;
  if (bare > 4) die('裸 sim-prompt 块数量异常');
}
console.log(`· 裸 /api/preset/sim-prompt 删除 ${bare} 个块`);

// 残留检查
if (src.includes("/api/preset/sim-prompt")) {
  const left = src.split('\n').filter((l) => l.includes('/api/preset/sim-prompt')).length;
  die(`仍有 ${left} 处 /api/preset/sim-prompt 残留`);
}

if (DRY) {
  console.log('· dry-run，未写盘');
} else {
  fs.writeFileSync(FILE, src);
  console.log(`· 已写盘 ${FILE}（${before} → ${src.split('\n').length} 行）`);
}

