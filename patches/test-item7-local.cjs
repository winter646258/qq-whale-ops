// test-item7-local.cjs
// 从补丁后的 bridge.js 里「原样抽出」被改的函数，在 vm 里用桩跑。
// findSticker / normalizeStickerEntry 直接从真实的 sticker-lib.js 里取（去掉 export），
// 这样测的就是线上同一份实现，不是我自己重写一遍。
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync('bridge-patched7.js', 'utf8');
const LIB = fs.readFileSync('sticker-lib.js', 'utf8')
  .replace(/^import .*$$/gm, '')
  .replace(/^export /gm, '');

function extractFunction(name) {
  const sig = `function ${name}(`;
  const at = SRC.indexOf(sig);
  if (at < 0) throw new Error('找不到函数 ' + name);
  let p = SRC.indexOf('(', at);
  let pd = 0;
  for (; p < SRC.length; p += 1) {
    if (SRC[p] === '(') pd += 1;
    else if (SRC[p] === ')') {
      pd -= 1;
      if (pd === 0) { p += 1; break; }
    }
  }
  let i = SRC.indexOf('{', p);
  let depth = 0;
  for (; i < SRC.length; i += 1) {
    const c = SRC[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(at, i + 1);
    }
  }
  throw new Error('大括号不闭合 ' + name);
}

function extractDecl(name) {
  const at = SRC.indexOf(`  const ${name} = `) >= 0
    ? SRC.indexOf(`  const ${name} = `)
    : SRC.indexOf(`  let ${name} = `);
  if (at < 0) throw new Error('找不到声明 ' + name);
  const end = SRC.indexOf(';', at);
  return SRC.slice(at, end + 1).trim();
}

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) pass += 1;
  else fails.push(label);
}
function eq(a, b, label) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  ok(A === B, `${label}  (${A} !== ${B})`);
}

// ── 沙箱 ────────────────────────────────────────────────────
const env = {
  Date,
  Math,
  console,
  fs: { readFileSync() { throw new Error('fs stub'); }, writeFileSync() {}, existsSync() { return false; }, mkdirSync() {}, readdirSync() { return []; } },
  logLines: [],
  invalidated: 0,
  log(...args) { env.logLines.push(args.map(String).join(' ')); },
  invalidateSlangLearnerSession() { env.invalidated += 1; env.logLines.push('[invalidate]'); }
};
env.globalThis = env;

const ctx = vm.createContext(env);
vm.runInContext(LIB, ctx, { filename: 'sticker-lib.js' });

const decls = [
  'SLANG_LEARNER_REBUILD_MAX',
  'SLANG_LEARNER_REBUILD_WINDOW_MS',
  'SLANG_LEARNER_PROVIDER_BACKOFF_MS',
  'slangLearnerRebuildAt',
  'slangLearnerBlockedUntil',
  'slangLearnerLastFailure'
].map(extractDecl).map((s) => s.replace(/^const /, 'var ').replace(/^let /, 'var '));

const fns = [
  'classifySlangLearnerError',
  'decideSlangLearnerAction',
  'noteSlangLearnerRebuild',
  'noteSlangLearnerHealthy',
  'handleSlangLearnerFailure',
  'resolveStickerRef',
  'stickerRefError'
].map(extractFunction);

vm.runInContext(decls.join('\n') + '\n' + fns.join('\n'), ctx, { filename: 'extracted.js' });

const R = (name) => vm.runInContext(name, ctx);
const call = (expr) => vm.runInContext(expr, ctx);

// ══ A. classifySlangLearnerError ═════════════════════════════
console.log('── A 失败分类 ──');
eq(call(`classifySlangLearnerError('学习会话 turn 未正常完成：error')`), 'unknown', 'A1 通用 turn error 归 unknown');
eq(call(`classifySlangLearnerError('buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel')`), 'provider', 'A2 buddy 渠道拦截归 provider');
eq(call(`classifySlangLearnerError('selectModel failed: forbidden: 403')`), 'provider', 'A3 forbidden/403 归 provider');
eq(call(`classifySlangLearnerError('session.prompt failed: not_found: no such session')`), 'stale', 'A4 not_found 归 stale');
eq(call(`classifySlangLearnerError('会话不存在，可能已删除')`), 'stale', 'A5 中文「不存在/已删除」归 stale');
eq(call(`classifySlangLearnerError('等待学习会话 turn 超时(120000ms)')`), 'timeout', 'A6 超时归 timeout（旧正则漏判的就是这条）');
eq(call(`classifySlangLearnerError('')`), 'unknown', 'A7 空串归 unknown');
eq(call(`classifySlangLearnerError(null)`), 'unknown', 'A8 null 归 unknown');
ok(call(`classifySlangLearnerError('学习会话 turn 未正常完成：error') !== 'stale'`), 'A9 关键的误判修复：含「会话」二字不再被判成 stale');

// ══ B. decideSlangLearnerAction ══════════════════════════════
console.log('── B 重建决策 ──');
eq(call(`decideSlangLearnerAction({kind:'provider', now:1000, rebuildTimes:[], blockedUntil:0})`),
  { action: 'backoff', rebuild: false, retry: false, waitMs: 600000, reason: 'provider' }, 'B1 provider 只退避不重建');
eq(call(`decideSlangLearnerAction({kind:'stale', now:1000, rebuildTimes:[], blockedUntil:0})`),
  { action: 'rebuild', rebuild: true, retry: true, waitMs: 0, reason: 'stale' }, 'B2 stale 重建并允许重试');
eq(call(`decideSlangLearnerAction({kind:'timeout', now:1000, rebuildTimes:[], blockedUntil:0})`).retry, false, 'B3 timeout 重建但不重试');
eq(call(`decideSlangLearnerAction({kind:'unknown', now:1000, rebuildTimes:[], blockedUntil:0})`).action, 'rebuild', 'B4 unknown 也重建');
eq(call(`decideSlangLearnerAction({kind:'stale', now:1000, rebuildTimes:[100,200,300], blockedUntil:0})`).action, 'exhausted', 'B5 窗口内满 3 次则耗尽');
eq(call(`decideSlangLearnerAction({kind:'stale', now:1000, rebuildTimes:[100,200], blockedUntil:0})`).action, 'rebuild', 'B6 只重建 2 次仍可继续');
eq(call(`decideSlangLearnerAction({kind:'stale', now:2000000, rebuildTimes:[100,200,300], blockedUntil:0})`).action, 'rebuild', 'B7 窗口外的旧记录不计入');
eq(call(`decideSlangLearnerAction({kind:'provider', now:1000, rebuildTimes:[], blockedUntil:5000})`),
  { action: 'backoff', rebuild: false, retry: false, waitMs: 4000, reason: 'cooling' }, 'B8 退避期内优先 cooling 且 waitMs 为剩余时间');
eq(call(`decideSlangLearnerAction({now:1000, rebuildTimes:[], blockedUntil:0})`).action, 'rebuild', 'B9 不传 kind 时按 unknown 处理');

// ══ C. noteSlangLearnerRebuild / Healthy ═════════════════════
console.log('── C 重建计数与恢复 ──');
call(`slangLearnerRebuildAt.length = 0; slangLearnerBlockedUntil = 0; slangLearnerLastFailure = null;`);
call(`noteSlangLearnerRebuild(1000)`);
call(`noteSlangLearnerRebuild(2000)`);
eq(call(`slangLearnerRebuildAt.length`), 2, 'C1 两次重建都被记录');
call(`noteSlangLearnerRebuild(1000 + 31 * 60 * 1000)`);
eq(call(`slangLearnerRebuildAt.length`), 1, 'C2 超过窗口的旧记录被剪掉，只剩最新那条');
call(`slangLearnerBlockedUntil = Date.now() + 60000; slangLearnerLastFailure = {kind:'provider'}; slangLearnerRebuildAt.push(1,2);`);
call(`noteSlangLearnerHealthy()`);
eq(call(`slangLearnerBlockedUntil`), 0, 'C3 成功后解除退避');
eq(call(`slangLearnerRebuildAt.length`), 0, 'C4 成功后清空重建计数');
eq(call(`slangLearnerLastFailure`), null, 'C5 成功后清空上次失败记录');

// ══ D. handleSlangLearnerFailure ═════════════════════════════
console.log('── D 失败处理接线 ──');
call(`slangLearnerRebuildAt.length = 0; slangLearnerBlockedUntil = 0; slangLearnerLastFailure = null;`);
env.invalidated = 0; env.logLines.length = 0;
eq(call(`handleSlangLearnerFailure('黑话研究', new Error('buddy: Illegal API invocation from an unapproved channel'))`), false, 'D1 provider 失败返回 false（不重试）');
eq(env.invalidated, 0, 'D2 provider 失败不销毁会话（重建无用）');
ok(call(`slangLearnerBlockedUntil > Date.now()`), 'D3 provider 失败设置退避');
ok(env.logLines.some((l) => l.includes('渠道问题，重建会话无用')), 'D4 日志明确说明为什么重建没用');

env.invalidated = 0; env.logLines.length = 0;
call(`slangLearnerBlockedUntil = 0;`);
eq(call(`handleSlangLearnerFailure('黑话研究', new Error('session.prompt failed: not_found: no such session'))`), true, 'D5 stale 失败返回 true（可重试）');
eq(env.invalidated, 1, 'D6 stale 失败销毁会话');
eq(call(`slangLearnerRebuildAt.length`), 1, 'D7 stale 失败记一次重建');

env.invalidated = 0;
eq(call(`handleSlangLearnerFailure('黑话研究', new Error('等待学习会话 turn 超时(120000ms)'))`), false, 'D8 timeout 失败不重试');
eq(env.invalidated, 1, 'D9 timeout 失败仍重建（真陈旧的常见形态）');

env.invalidated = 0; env.logLines.length = 0;
call(`slangLearnerRebuildAt.length = 0; slangLearnerBlockedUntil = 0;`);
for (let i = 0; i < 3; i += 1) call(`handleSlangLearnerFailure('x', new Error('等待学习会话 turn 超时(1ms)'))`);
  eq(env.invalidated, 3, 'D10 前三次都重建');
  env.invalidated = 0;
  call(`handleSlangLearnerFailure('x', new Error('等待学习会话 turn 超时(1ms)'))`);
  eq(env.invalidated, 0, 'D11 预算耗尽后不再销毁会话');
  ok(env.logLines.some((l) => l.includes('暂停自动研究')), 'D12 明确告知「暂停自动研究」');

// ══ E. resolveStickerRef ════════════════════════════════════
console.log('── E 表情引用解析 ──');
const entries = [
  { id: 'mfuns-11', desc: '你这吃白饭的蓝色大肥鱼', localNote: '', tags: [], useCount: 5 },
  { id: 'mfuns-02', desc: '去问你的豆包', localNote: '', tags: [], useCount: 2 },
  { id: 'mfuns-17', desc: '得加钱', localNote: '要钱专用', tags: ['钱'], useCount: 9 },
  { id: 'aige-009', desc: '', localNote: '猫猫嘲讽图', tags: ['猫'], useCount: 1 },
  { id: 'dup-1', desc: '干饭', localNote: '', tags: [], useCount: 3 },
  { id: 'dup-2', desc: '干饭', localNote: '', tags: [], useCount: 8 }
];
ctx.entries = entries;
env.entries = entries;

eq(call(`resolveStickerRef(entries, 'mfuns-11')`).how, 'exact', 'E1 正确 id 走精确匹配');
eq(call(`resolveStickerRef(entries, 'mfuns-11')`).entry.id, 'mfuns-11', 'E2 精确匹配返回原记录');
const e3 = call(`resolveStickerRef(entries, '你这吃白饭的蓝色大肥鱼')`);
eq(e3.how, 'desc', 'E3 传描述能解析（线上 01:01:40Z 失败的就是这条）');
eq(e3.entry.id, 'mfuns-11', 'E4 描述命中到 mfuns-11');
eq(call(`resolveStickerRef(entries, '「你这吃白饭的蓝色大肥鱼」')`).entry.id, 'mfuns-11', 'E5 带中文书名号也能剥掉');
eq(call(`resolveStickerRef(entries, '要钱专用')`).entry.id, 'mfuns-17', 'E6 备注精确命中');
eq(call(`resolveStickerRef(entries, '猫猫嘲讽')`).how, 'desc', 'E7 备注子串命中唯一');
const e8 = call(`resolveStickerRef(entries, '干饭')`);
eq(e8.how, 'ambiguous', 'E8 两条同名描述不猜，交给她挑');
eq(e8.candidates.length, 2, 'E9 候选列表带 2 条');
eq(e8.candidates[0].id, 'dup-2', 'E10 候选按使用次数降序（dup-2 用得更多）');
eq(call(`resolveStickerRef(entries, '根本不存在的表情')`).how, 'none', 'E11 完全没命中返回 none');
eq(call(`resolveStickerRef(entries, '')`).how, 'empty', 'E12 空串返回 empty');
eq(call(`resolveStickerRef([], 'mfuns-11')`).how, 'none', 'E13 空库返回 none');
eq(call(`resolveStickerRef(null, 'mfuns-11')`).how, 'none', 'E14 entries 为 null 不抛');
eq(call(`resolveStickerRef(entries, null)`).how, 'empty', 'E15 ref 为 null 返回 empty');
// 前缀匹配（40 分）命中多条时必须让她挑，不能瞎猜
const pref = call(`resolveStickerRef(entries, '干饭了')`);
eq(pref.entry, null, 'E16 只有前缀相似时不直接采用');

// ══ F. stickerRefError ══════════════════════════════════════
console.log('── F 错误文案 ──');
const amb = call(`stickerRefError('干饭', {how:'ambiguous', candidates: [{id:'dup-1',desc:'干饭'},{id:'dup-2',desc:'干饭'}]}, entries)`);
ok(amb.includes('dup-1') && amb.includes('dup-2'), 'F1 歧义时报出候选 id');
ok(amb.includes('挑一个'), 'F2 歧义时告诉她怎么办');
const none = call(`stickerRefError('蓝色大肥鱼', {how:'none', candidates: []}, entries)`);
ok(none.includes('必须是 id 而不是描述'), 'F3 没命中时讲清 id 与描述的区别');
ok(none.includes('mfuns-11'), 'F4 没命中时给出真实 id 样例');
ok(none.includes('qq_list_stickers'), 'F5 没命中时指路 qq_list_stickers');
const emptyLib = call(`stickerRefError('x', {how:'none', candidates: []}, [])`);
ok(emptyLib.includes('库里没有表情'), 'F6 空库时不崩且说明');

// ══ 汇总 ════════════════════════════════════════════════════
console.log('\n' + '='.repeat(56));
if (fails.length) {
  console.log(`❌ ${pass} 过，${fails.length} 失败：`);
  for (const f of fails) console.log('   - ' + f);
  process.exit(1);
} else {
  console.log(`✅ 全部 ${pass} 条断言通过`);
}
