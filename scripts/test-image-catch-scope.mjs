// 回归守卫：src/modules/image/generate.js 的 catch 分支作用域
//
// 2026-10-27 线上 bug：image() 把 key/body 用 const 声明在 try 内，catch 里却要
// 用 key 调 reportImageUsage —— try 内一出错，catch 自己先抛
// `ReferenceError: key is not defined`：
//   ① 真正的错误被吃掉（日志里只剩 key is not defined）；
//   ② 后面的 sendJson 永远执行不到，调用方拿不到响应，回合被拖到超时才中止。
// 只在「免审批放行」分支触发（reportOnly=true 才进那段报备）。
//
// 这个用例不启控制台、不碰网络，直接以伪 ctx 调 handler：
// 修复前 case1 抛 ReferenceError 且 sendJson 0 次；修复后 sendJson 1 次 + 报备拿到 key。
//
// 跑法：node scripts/test-image-catch-scope.mjs
import assert from 'node:assert/strict';
import { imageRoutes } from '../src/modules/image/generate.js';

const handler = imageRoutes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/image')?.handler;
if (typeof handler !== 'function') {
  console.error('❌ 找不到 POST /api/socialV2/image 的 handler，路由表可能过时了');
  process.exit(1);
}

function makeCtx(reportImageUsage) {
  return {
    cfg: { socialV2: { image: { enabled: true } } },
    log: () => {},
    path: { basename: (p) => String(p).split(/[\\/]/).pop() },
    imageHelpers: {
      // 让额度判定失败，把请求推进「免审批放行」分支
      imageAllowedNow: () => ({ ok: false, why: 'no quota' }),
      imageReportOnly: () => true,
      imageApprovalEligible: () => true,
      maxPromptChars: () => 2000,
      throttleMs: () => 60000,
      lastStartAt: () => 0,
      markStart: () => {},
      // 生图本身失败 —— 就是线上踩到的那一步
      generateImageNow: async () => { throw new Error('upstream 504'); },
      reportImageUsage,
      onebotSend: async () => {},
    },
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
}

async function callHandler({ withReportHook }) {
  const calls = [];
  const reports = [];
  const ctx = makeCtx(withReportHook ? ((info) => { reports.push(info); return Promise.resolve(); }) : undefined);
  let threw = null;
  try {
    await handler.call({ ctx }, {
      req: { method: 'POST', headers: {} },
      url: { searchParams: new URLSearchParams() },
      sendJson: (payload, status) => calls.push({ payload, status }),
      readBody: async () => ({ key: 'private:2627346728', action: 'generate', prompt: '画一只鲸鱼' }),
    });
  } catch (error) {
    threw = error;
  }
  // reportImageUsage 是 void 调用，等一个 tick 让它落地
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { threw, calls, reports };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name} —— ${error?.message ?? error}`);
  }
}

console.log('case1 免审批放行 + 有报备钩子（线上踩到的路径）');
const c1 = await callHandler({ withReportHook: true });
check('handler 不抛异常', () => assert.equal(c1.threw, null, String(c1.threw)));
check('客户端收到且只收到一个响应', () => assert.equal(c1.calls.length, 1));
check('响应是 500 生图失败', () => {
  assert.equal(c1.calls[0]?.status, 500);
  assert.match(String(c1.calls[0]?.payload?.error ?? ''), /生图失败/);
});
check('报备拿到了 key 和错误', () => {
  assert.equal(c1.reports.length, 1);
  assert.equal(c1.reports[0].key, 'private:2627346728');
  assert.equal(c1.reports[0].scene, 'report-only');
  assert.equal(c1.reports[0].ok, false);
  assert.match(String(c1.reports[0].error ?? ''), /upstream 504/);
});

console.log('case2 免审批放行 + 没有报备钩子（对照）');
const c2 = await callHandler({ withReportHook: false });
check('handler 不抛异常', () => assert.equal(c2.threw, null, String(c2.threw)));
check('客户端仍收到 500', () => {
  assert.equal(c2.calls.length, 1);
  assert.equal(c2.calls[0]?.status, 500);
});

if (failed) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
