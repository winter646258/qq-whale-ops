// 阶段24：/api/socialV2/share-signal 与 /api/socialV2/shared-memory 搬进 share 模块。
// 幂等：注入块用独立 MARKER；删除区按 if 头 + 大括号配平定位。
//
// 依赖声明位置（改动前 src/bridge.js 行号）：
//   顶层 import（交引用安全）：shared-memory-store.js 的 canRead/addItem/pruneStore/listItems/
//     listGroupScopeForOwner/findSimilar/forgetItem/statsOf as sharedMemoryStats/
//     MAX_ITEMS as SHARED_MEMORY_MAX_ITEMS/MAX_ARCHIVED as SHARED_MEMORY_MAX_ARCHIVED（L86–101）；
//     share-signal-store.js 的 addSignal/setPolicy as setSharePolicy/statsOf as shareStatsOf/
//     normalizePolicy as normalizeSharePolicy/isGroupKey/UNANSWERED_THRESHOLD/
//     MAX_SIGNALS as SHARE_MAX_SIGNALS/HARD_MIN_INTERVAL_MS as SHARE_HARD_MIN_INTERVAL_MS/
//     HARD_MAX_PER_DAY as SHARE_HARD_MAX_PER_DAY（L105–114）。
//   main() 内、声明晚于注入点（必须包箭头）：getShareState 3960 / persistShareState 3979 /
//     getSharedMemoryState 3830 / persistSharedMemoryState 3835 / sharedMemoryReaderFor 3869 /
//     shareRejectReason 4132。
//   startConsoleServer() 内局部：agentTokenOk / v2SessionAllowed / v2ToolEnabled（见 modules-ctx-ops-token）。
//
// 踩坑提示：这两条路由的 body 解析是 `req.method === 'POST' ? await readBody() : {}`，
//   readBody 在 GET 时返回 undefined，老代码共享 memory 那边没兜 `?? {}`，
//   这里统一写成 `(await readBody()) ?? {}`。
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

const MARK = '// MARKER: modules-ctx-share';
if (!s.includes(MARK)) {
  const anchor = '  // MARKER: modules-ctx-send-legacy';
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到锚点 ' + anchor);
  const j = s.indexOf('\n  });\n', i) + '\n  });\n'.length;
  const block = [
    '',
    '  // MARKER: modules-ctx-share',
    '  // 阶段24：主动报告与跨会话记忆。',
    '  // 纯逻辑是叶子模块 import，交引用安全；main() 内函数声明在本块之后，必须包箭头。',
    '  Object.assign(moduleCtx, {',
    '    shareStatsOf, normalizeSharePolicy, setSharePolicy, addSignal, shareRejectReason, isGroupKey,',
    '    SHARE_HARD_MIN_INTERVAL_MS, SHARE_HARD_MAX_PER_DAY, SHARE_MAX_SIGNALS,',
    '    listItems, listGroupScopeForOwner, findSimilar, addItem, pruneStore, canRead, forgetItem,',
    '    sharedMemoryStats, SHARED_MEMORY_MAX_ITEMS, SHARED_MEMORY_MAX_ARCHIVED,',
    '    shareHelpers: {',
    '      getShareState: () => getShareState(),',
    '      persistShareState: (args) => persistShareState(args),',
    '      getSharedMemoryState: () => getSharedMemoryState(),',
    '      persistSharedMemoryState: (store, args) => persistSharedMemoryState(store, args),',
    '      sharedMemoryReaderFor: (key) => sharedMemoryReaderFor(key),',
    '    },',
    '  });',
    '',
  ].join('\n');
  s = s.slice(0, j) + block + s.slice(j);
  console.log('注入', MARK);
} else { console.log('跳过注入', MARK); }

function dropIfBlock(head) {
  const a = s.indexOf(head);
  if (a < 0) { console.log('跳过删除', head.trim().slice(0, 50)); return; }
  let depth = 0, i = a, end = -1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = s.indexOf('\n', i) + 1; break; } }
    i += 1;
  }
  if (end < 0) throw new Error('括号不配平：' + head);
  console.log('删除', s.slice(a, end).split('\n').length - 1, '行 <-', head.trim().slice(0, 60));
  s = s.slice(0, a) + s.slice(end);
}

dropIfBlock("        if (url.pathname === '/api/socialV2/share-signal') {");
dropIfBlock("        if (url.pathname === '/api/socialV2/shared-memory') {");
// 这两块前面的说明注释（含子级 // MARKER: shared-memory-route）留着没意义，一并清掉
s = s.replace(/        \/\/ MARKER: shared-memory-route\n(?:        \/\/.*\n)*/, '');

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log('bridge.js ' + before + ' -> ' + s.length + ' 字节');