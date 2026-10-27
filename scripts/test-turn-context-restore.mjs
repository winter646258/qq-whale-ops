// 回归守卫：重启/断线恢复的回合必须把「回合上下文」也登记回去。
//
// 背景（2026-10-27 16:52:58 实测）：重启后 session-c603df85（private:1124721191）的回合
// 被 rebuildInFlightCollector 恢复了（回复不会丢），但 __qqTurnContexts 是空的 —— 那个还在跑的
// 回合去调生图工具，imageAllowedNow 判成「没有回合上下文」直接拒：日志一行
//   [image] 拒绝 private:1124721191：没有回合上下文
// 于是"回复保住了，额度丢了"。这个用例守的就是这一步。
//
// 跑法：node scripts/test-turn-context-restore.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

function extract(signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`抽不出 ${signature}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${signature} 花括号不闭合`);
}

const ctxSrc = [
  extract('function turnCtxMap(name) {'),
  extract('function activeTurnCtx(key) {'),
  extract('function endedTurnCtx(key) {'),
  extract('function setActiveTurnCtx(ctx) {'),
  extract('function endActiveTurnCtx(key) {'),
].join('\n');
const rebuildSrc = extract('function rebuildInFlightCollector(sessionId, records) {');

// 用真实源码建一个隔离环境：ctx 那几个函数照原样跑（它们只碰 globalThis），
// rebuildInFlightCollector 依赖的 collectors / reverse / createTurnCollector / log 用桩喂进去。
const buildHarness = new Function(
  'globalThis',
  `${ctxSrc}
   return { activeTurnCtx, setActiveTurnCtx, endActiveTurnCtx,
     makeRebuild: (createTurnCollector, collectors, reverse, log) =>
       new Function('createTurnCollector', 'collectors', 'reverse', 'log', 'activeTurnCtx', 'setActiveTurnCtx',
         'return (' + ${JSON.stringify(rebuildSrc)} + ');')(createTurnCollector, collectors, reverse, log, activeTurnCtx, setActiveTurnCtx)
   };`,
);

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failed += 1; console.log(`  ❌ ${name} —— ${error?.message ?? error}`); }
}
function fresh() {
  globalThis.__qqTurnContexts = new Map();
  globalThis.__qqTurnContextEnds = new Map();
  const logs = [];
  const collectors = new Map();
  const reverse = new Map();
  const createTurnCollector = () => ({ pushed: [], push(e) { this.pushed.push(e); return true; } });
  const h = buildHarness(globalThis);
  const rebuild = h.makeRebuild(createTurnCollector, collectors, reverse, logTo(logs));
  function logTo(arr) { return (m) => arr.push(String(m)); }
  return { ...h, collectors, reverse, rebuild, logs };
}
const ev = (type, turn) => ({ type: 'event', event: { type, data: { turn } } });
const openTurn = [ev('turn/start', 48), ev('assistant/message', 48)];
const closedTurn = [ev('turn/start', 47), ev('turn/end', 47)];

console.log('场景1 恢复进行中的回合时，回合上下文一起补回来');
{
  const t = fresh();
  t.reverse.set('sess-1', 'private:1124721191');
  check('恢复前没有上下文', () => assert.equal(t.activeTurnCtx('private:1124721191'), null));
  t.rebuild('sess-1', openTurn);
  const ctx = t.activeTurnCtx('private:1124721191');
  check('恢复后有上下文', () => assert.ok(ctx, '应该是 truthy'));
  check('上下文指回正确的会话 key', () => assert.equal(String(ctx.key), 'private:1124721191'));
  check('上下文带时间戳（回合窗口要算它）', () => assert.ok(Number(ctx.at) > 0));
  check('collector 也建好了', () => assert.ok(t.collectors.get('sess-1')));
  check('日志里记了这一笔', () => assert.ok(t.logs.some((l) => l.includes('恢复了回合上下文'))));
}

console.log('场景2 已经有上下文的，不覆盖（运行中重连别打架）');
{
  const t = fresh();
  t.reverse.set('sess-1', 'private:1124721191');
  t.setActiveTurnCtx({ key: 'private:1124721191', reason: 'private', at: 111 });
  t.rebuild('sess-1', openTurn);
  check('原有上下文原样保留', () => assert.equal(t.activeTurnCtx('private:1124721191').at, 111));
  check('reason 没被改成 resume', () => assert.equal(t.activeTurnCtx('private:1124721191').reason, 'private'));
}

console.log('场景3 回合已结束的不补上下文（没什么可恢复的）');
{
  const t = fresh();
  t.reverse.set('sess-1', 'private:1124721191');
  t.rebuild('sess-1', closedTurn);
  check('没有上下文', () => assert.equal(t.activeTurnCtx('private:1124721191'), null));
}

console.log('场景4 反查不到 key 的会话：不抛错，也不乱认');
{
  const t = fresh();
  check('不抛错', () => t.rebuild('sess-unknown', openTurn));
  check('没有凭空造上下文', () => assert.equal(t.activeTurnCtx('sess-unknown'), null));
  check('collector 仍然恢复（回复优先）', () => assert.ok(t.collectors.get('sess-unknown')));
}

console.log('场景5 空/坏 records 不炸');
{
  const t = fresh();
  t.reverse.set('sess-1', 'private:1124721191');
  check('空数组', () => t.rebuild('sess-1', []));
  check('null', () => t.rebuild('sess-1', null));
  check('没有上下文', () => assert.equal(t.activeTurnCtx('private:1124721191'), null));
}

if (failed) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
