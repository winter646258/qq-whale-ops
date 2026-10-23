// 阶段6：Token 用量账本整族（/api/tokens/*）搬进模块
//
// 幂等。做的事：
//   1. 注入 tokenLedger / priceTable（都是 main() 内 const，只建一次不改引用）
//   2. 删掉老 if 链里的「大前缀 if + 五条内层 if」整块
//
// 为什么要连外层一起删：原写法是
//     if (summary === || startsWith('/api/tokens/')) { ...五条小 if...; sendJson 404 }
// 模块化后拆成五条独立 exact 路由，registry 的精确优先匹配天然处理
// 「未知 /api/tokens/xxx → 落到默认 404」，所以外层壳和那个内层 404 都是多余的。
import fs from 'node:fs';

const FILE = process.env.BRIDGE_FILE || '/opt/qq-bridge/src/bridge.js';
const DRY = process.argv.includes('--dry-run');

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const before = src.split('\n').length;

// ── 1. 注入 tokenLedger / priceTable ─────────────────────────────
const MARKER = '  // MARKER: modules-ctx-tokens\n';
if (src.includes(MARKER)) {
  console.log('· 已有 tokens 注入，跳过');
} else {
  // 必须落在两个 const 的声明之后：priceTable 在 L2880、tokenLedger 在 L2881，
  // 它们后面的 import 段落里第一个稳定锚点是 `  // ── 群聊黑话` 之类的注释。
  // 这里用 createTokenLedger 调用结束的 `  });` + 后续注释行定位不可靠，
  // 所以改用「按行找 tokenLedger 声明块结束」再插入。
  const anchorText = '  const tokenLedger = createTokenLedger({';
  const at = src.indexOf(anchorText);
  if (at < 0) die(`找不到 ${anchorText}`);
  // 从 at 开始按括号配平找到声明块结束（`});`）
  let depth = 0;
  let end = -1;
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // 期待紧跟 `)` 与换行
        const close = src.indexOf(';', i);
        end = close + 1;
        break;
      }
    }
  }
  if (end < 0) die('tokenLedger 声明块配平失败');
  // 到行尾
  const lineEnd = src.indexOf('\n', end) + 1;
  const block = `${MARKER}  // Token 用量账本模块：tokenLedger / priceTable 都是只建一次的 const，
  // 之后只调方法、不改引用，所以直接交引用是安全的。
  Object.assign(moduleCtx, { tokenLedger, priceTable });
`;
  src = src.slice(0, lineEnd) + block + src.slice(lineEnd);
  console.log('· 注入 tokenLedger / priceTable');
}

// ── 2. 删老 if 链里的 tokens 整块 ────────────────────────────────
const NEEDLE = "if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {";
if (!src.includes(NEEDLE)) {
  console.log('· tokens 路由块已不在，跳过删除');
} else {
  const at = src.indexOf(NEEDLE);
  const startMarker = '        if (';
  const blockStart = src.lastIndexOf(startMarker, at);
  if (blockStart < 0) die('tokens 路由块定位异常');
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
  if (end < 0) die('tokens 路由块配平失败');
  while (src[end] === '\n' || src[end] === '\r') end += 1;
  const lineNo = src.slice(0, blockStart).split('\n').length;
  const lines = src.slice(blockStart, end).split('\n').length - 1;
  src = src.slice(0, blockStart) + src.slice(end);
  console.log(`· 删除 tokens 前缀块（${lines} 行，原 L${lineNo}）`);
}

if (src.includes("/api/tokens/summary'")) {
  const left = src.split('\n').filter((l) => l.includes('/api/tokens/')).length;
  // 只允许模块文件里有，bridge.js 里不该再有
  die(`bridge.js 仍有 ${left} 处 /api/tokens/ 残留`);
}

if (DRY) {
  console.log('· dry-run，未写盘');
} else {
  fs.writeFileSync(FILE, src);
  console.log(`· 已写盘 ${FILE}（${before} → ${src.split('\n').length} 行）`);
}

