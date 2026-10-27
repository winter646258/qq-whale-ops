// 回归守卫：生图闸门的「当前回合」必须按会话分开存（多会话并发）
//
// 2026-10-27 线上现象：主人（private:1124721191）要生图，回一句
// 「这个会话不是当前正在进行的那个」，试两回一模一样。
//
// 根因：imageAllowedNow() 读的是 globalThis.__qqTurnContext 单个全局槽，
// 而线上群 906710082 / 群 201188739 / 好几个私聊同时在跑 —— 后开始的回合把
// 先开始的顶掉，先那个会话调生图工具时 ctx.key !== key 就拒绝。
// 那条分支连日志都不打，所以线上毫无痕迹。
//
// 这个用例把 src/bridge.js 里真实的 imageAllowedNow（连同 per-key 辅助函数）抽出来，
// 用伪 cfg / 伪 log / 伪 imageSceneFor 跑真实场景。第一个用例就是线上那条：
// 主人回合开始后，别的会话也开了一轮 —— 主人必须仍然能画。
//
// 跑法：node scripts/test-image-turn-context.mjs
//      node scripts/test-image-turn-context.mjs <bridge.js 路径>   # 拿老版本验红
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, '..', 'src', 'bridge.js');
const src = fs.readFileSync(target, 'utf8');

/** 从源码里按花括号配对抽出一个函数（含可选的前置辅助函数）。 */
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const helpers = ['turnCtxMap', 'activeTurnCtx', 'endedTurnCtx', 'setActiveTurnCtx', 'endActiveTurnCtx']
  .map((n) => extractFn(src, n))
  .filter(Boolean);
const imageAllowedNowSrc = extractFn(src, 'imageAllowedNow');
if (!imageAllowedNowSrc) {
  console.error(`❌ 从 ${target} 里抽不出 imageAllowedNow`);
  process.exit(1);
}

// 抽出来的这段代码依赖 3 个外部名字：cfg / log / imageSceneFor。
// 老版本没有 per-key 辅助函数，只导出 imageAllowedNow 自己。
const exported = helpers.length === 5
  ? 'imageAllowedNow, setActiveTurnCtx, endActiveTurnCtx'
  : 'imageAllowedNow';
const build = new Function(
  'cfg', 'log', 'imageSceneFor',
  `${helpers.join('\n\n')}\n\n${imageAllowedNowSrc}\n\nreturn { ${exported} };`
);

function fresh() {
  // 每个场景都从干净的全局开始，避免用例之间互相污染
  delete globalThis.__qqTurnContext;
  delete globalThis.__qqTurnContextEnded;
  delete globalThis.__qqTurnContexts;
  delete globalThis.__qqTurnContextEnds;
  const cfg = { socialV2: { image: { turnWindowMs: 600000, turnGraceMs: 90000 } } };
  const log = () => {};
  // 只有主人在私聊/群里被 @ 时才算允许画 —— 简化版 imageSceneFor
  const imageSceneFor = (key) => (String(key) === 'private:1124721191' ? 'owner-private' : null);
  return { ...build(cfg, log, imageSceneFor), hasHelpers: helpers.length === 5 };
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failed += 1; console.log(`  ❌ ${name} —— ${error?.message ?? error}`); }
}

console.log(`被测源码：${target}`);
console.log(`per-key 辅助函数：${helpers.length === 5 ? '有（新版）' : '无（旧版，单全局槽）'}\n`);

const OWNER = 'private:1124721191';
const FRIEND = 'private:2627346728';

if (helpers.length < 5) {
  // ── 旧版：直接按线上那个并发顺序走，应该被拒绝 ──
  console.log('旧版场景（线上 15:46:52 的顺序）');
  const g = fresh();
  globalThis.__qqTurnContext = { key: OWNER, reason: 'private', at: Date.now() };
  // 紧接着别的会话也开了一轮，把全局槽顶掉
  globalThis.__qqTurnContext = { key: FRIEND, reason: 'private', at: Date.now() };
  const r = g.imageAllowedNow(OWNER);
  check('主人回合被顶掉后仍能画（旧版这里会失败）', () => assert.equal(r.ok, true, `实际被拒：${r.why}`));
  check('拒绝原因正是线上那句', () => {
    if (r.ok) return;
    assert.equal(r.why, '这个会话不是当前正在进行的那个');
  });
} else {
  // ── 新版：同样的并发顺序，主人必须仍然能画 ──
  console.log('场景1 别的会话后开始，把回合上下文顶掉（线上原样）');
  {
    const g = fresh();
    g.setActiveTurnCtx({ key: OWNER, reason: 'private', at: Date.now() });
    g.setActiveTurnCtx({ key: FRIEND, reason: 'private', at: Date.now() });
    const r = g.imageAllowedNow(OWNER);
    check('主人仍能画', () => assert.equal(r.ok, true, `实际被拒：${r.why}`));
    check('场景是 owner-private', () => assert.equal(r.scene, 'owner-private'));
  }

  console.log('场景2 别的会话回合结束，不影响主人');
  {
    const g = fresh();
    g.setActiveTurnCtx({ key: OWNER, reason: 'private', at: Date.now() });
    g.setActiveTurnCtx({ key: FRIEND, reason: 'private', at: Date.now() });
    g.endActiveTurnCtx(FRIEND);
    const r = g.imageAllowedNow(OWNER);
    check('主人仍能画', () => assert.equal(r.ok, true, `实际被拒：${r.why}`));
  }

  console.log('场景3 主人回合收工 → 90 秒宽限仍然有效');
  {
    const g = fresh();
    g.setActiveTurnCtx({ key: OWNER, reason: 'private', at: Date.now() });
    g.endActiveTurnCtx(OWNER);
    const r = g.imageAllowedNow(OWNER);
    check('宽限内能画', () => assert.equal(r.ok, true, `实际被拒：${r.why}`));
  }

  console.log('场景4 完全没有回合上下文（真的不该画）');
  {
    const g = fresh();
    const r = g.imageAllowedNow(OWNER);
    check('被拒绝', () => assert.equal(r.ok, false));
    check('原因是没有进行中的对话', () => assert.equal(r.why, '当前没有进行中的对话'));
  }

  console.log('场景5 非主人的会话即使有回合也不能画');
  {
    const g = fresh();
    g.setActiveTurnCtx({ key: FRIEND, reason: 'private', at: Date.now() });
    const r = g.imageAllowedNow(FRIEND);
    check('被 imageSceneFor 拦下', () => assert.equal(r.ok, false));
  }

  console.log('场景6 回合超过 turnWindowMs 后不再放行');
  {
    const g = fresh();
    g.setActiveTurnCtx({ key: OWNER, reason: 'private', at: Date.now() - 601000 });
    const r = g.imageAllowedNow(OWNER);
    check('超窗口被拒', () => assert.equal(r.ok, false));
  }
}

if (failed) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
