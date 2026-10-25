// 阶段25：AI 工具面的黑话查询/提交（/api/socialV2/slang/query、/api/socialV2/slang/submit）
// 搬进已有的 slang 模块（原来这两条在 bridge.js if 链里，归 v2:memory 族）。
//
// 为什么放在 slang 模块而不是新建一个：这两条的全部语义都建立在黑话库上
// （confirmedSlangListV2 / createSlangEntry / allowSlangSubmit / saveSlangStore），
// 新建模块还要再交一遍同样的句柄，反而多一层。
//
// 依赖声明位置（改动前 src/bridge.js 行号）：
//   顶层 import：buildSlangContext 45 / SLANG_STATUS 52 / createSlangEntry（slang-store.js）/ appendActivity 738
//   main() 内、声明晚于 modules-ctx-slang 注入点（L1542）：
//     saveSlangStore 2461 / queueSlangTask 2475 / runSlangResearch 2725 /
//     allowSlangSubmit 2829 / publicSlangEntry 2847 / confirmedSlangListV2 2863
//   ⇒ 一律包箭头。
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

// 1) 给 slangHelpers 补 AI 工具面要用的 5 个句柄（同类写法：都包箭头，避开 TDZ）
const anchor = "      invalidateLearnerSession: () => invalidateSlangLearnerSession(),";
if (s.includes("      confirmedList: () => confirmedSlangListV2(),")) {
  console.log('跳过 slangHelpers 扩展');
} else {
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到 slangHelpers 锚点');
  const add = [
    anchor,
    '      // 阶段25：AI 工具面（原 if 链里的 slang/query、slang/submit）',
    '      confirmedList: () => confirmedSlangListV2(),',
    '      buildContext: (entries, max) => buildSlangContext(entries, max),',
    '      allowSubmit: (key) => allowSlangSubmit(key),',
    '      publicEntry: (e) => publicSlangEntry(e),',
    '      mergeEvidence: (oldList, addList) => mergeEvidence(oldList, addList),',
  ].join('\n');
  s = s.slice(0, i) + add + s.slice(i + anchor.length);
  console.log('扩展 slangHelpers');
}

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

dropIfBlock("        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {");
dropIfBlock("        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {");

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log('bridge.js ' + before + ' -> ' + s.length + ' 字节');