// 生图异步化回归守卫（MARKER: image-async-job）
//
// 要钉死的契约：
//   ① 请求必须在毫秒级返回（而不是等上游画完），返回体 ok:true + async:true + jobId；
//   ② 回执之后，后台仍然要真的把图发出去（onebotSend 带 path）；
//   ③ 同一个 key 在飞时，第二次调用不能再提交（不能并发画两张）；
//   ④ 后台失败时必须发一句通知，不能静默。
//
// 用法：node scripts/test-image-async.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const target = pathToFileURL(path.join(root, 'src/modules/image/generate.js')).href;
const { imageRoutes } = await import(target);
const image = imageRoutes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/image').handler;

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// ── 桩：一个会「画」2 秒的假上游 ──────────────────────────────
function makeCtx({ drawMs = 2000, fail = null, reportOnly = false }) {
  const sent = [];
  const usage = [];
  const logs = [];
  const ctx = {
    cfg: { socialV2: { image: { enabled: true, timeoutMs: 180000, model: 'gpt-image-2', size: '1024x1024' } } },
    log: (m) => logs.push(String(m)),
    path,
    imageHelpers: {
      agentTokenOkOrOwnerDelegate: () => false,
      // reportOnly 用例走「免审批放行」分支：permit 先被拒，再由 imageReportOnly 兜成放行，
      // 这样 reportImageUsage 才会被调用（真正走免审批的线上场景就是这条）。
      imageAllowedNow: () => (reportOnly
        ? { ok: false, why: '只有主人私聊、或主人在群里 @ 你/叫你名字时才能画' }
        : { ok: true, scene: 'owner-private' }),
      imageReportOnly: () => true,
      imageApprovalEligible: () => true,
      requestImageApproval: () => ({ ok: false, error: '不该走到这里' }),
      lastStartAt: () => 0,
      throttleMs: () => 60000,
      markStart: () => {},
      maxPromptChars: () => 2000,
      ttlMs: () => 600000,
      generateImageNow: async () => {
        await new Promise((r) => setTimeout(r, drawMs));
        if (fail) throw new Error(fail);
        return { url: 'https://example.invalid/x.png', path: '/opt/qq-bridge/state/images/img-test.png', model: 'gpt-image-2', size: '1024x1024' };
      },
      onebotSend: async (kind, id, message, replyTo, at, images) => {
        sent.push({ kind, id, message, images });
      },
      reportImageUsage: async (info) => { usage.push(info); }
    }
  };
  return { ctx, sent, usage, logs };
}

function makeReq(body) {
  return {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {}
  };
}

async function call(ctx, body) {
  let captured = null;
  let errorCode = null;
  const t0 = Date.now();
  await image.call({ ctx }, {
    req: makeReq(body),
    url: new URL('http://127.0.0.1/api/socialV2/image'),
    sendJson: (payload, code = 200) => { captured = payload; errorCode = code; },
    readBody: async () => body
  });
  return { payload: captured, code: errorCode, elapsedMs: Date.now() - t0 };
}

// ── ① 立刻回执 ────────────────────────────────────────────────
{
  const { ctx, sent } = makeCtx({ drawMs: 1500 });
  const r = await call(ctx, { key: 'private:1124721191', action: 'generate', prompt: '画一条会飞的鲸鱼' });
  check('立刻回执（不等上游画完）', r.elapsedMs < 500, `${r.elapsedMs}ms`);
  check('回执 ok:true', r.payload?.ok === true, JSON.stringify(r.payload?.ok));
  check('回执 async:true', r.payload?.async === true, JSON.stringify(r.payload?.async));
  check('回执带 jobId', typeof r.payload?.jobId === 'string' && r.payload.jobId.startsWith('img-'), String(r.payload?.jobId));
  check('回执里明确让别重复调', /别再调|不要再调/.test(String(r.payload?.note ?? '')), String(r.payload?.note ?? '').slice(0, 40));
  check('回执时不 panic（还没发图）', sent.length === 0, `sent=${sent.length}`);

  // ── ② 后台真的发图 ──────────────────────────────────────────
  await new Promise((r2) => setTimeout(r2, 2200));
  check('后台画完把图发出去了', sent.length === 1 && Array.isArray(sent[0].images) && sent[0].images.length === 1, JSON.stringify(sent));
}

// ── ③ 在飞时拒绝第二次 ────────────────────────────────────────
{
  const { ctx, sent } = makeCtx({ drawMs: 1200 });
  const first = await call(ctx, { key: 'group:906710082', action: 'generate', prompt: '第一张' });
  const second = await call(ctx, { key: 'group:906710082', action: 'generate', prompt: '第二张' });
  check('第一次入队成功', first.payload?.ok === true && first.payload?.async === true, JSON.stringify(first.payload?.jobId));
  check('第二次被挡（running:true）', second.payload?.running === true, JSON.stringify(second.payload));
  check('第二次沿用同一个 jobId', second.payload?.jobId === first.payload?.jobId, `${second.payload?.jobId} vs ${first.payload?.jobId}`);
  await new Promise((r2) => setTimeout(r2, 1800));
  check('只发了一张（没并发两张）', sent.length === 1, `sent=${sent.length}`);
}

// ── ④ 后台失败要说话 ─────────────────────────────────────────
{
  const { ctx, sent, usage } = makeCtx({ drawMs: 300, fail: '上游 504：{"error":"upstream timeout"}', reportOnly: true });
  const r = await call(ctx, { key: 'private:1124721191', action: 'generate', prompt: '画个会失败的' });
  check('失败也先回执成功', r.payload?.ok === true && r.payload?.async === true, JSON.stringify(r.payload?.ok));
  await new Promise((r2) => setTimeout(r2, 900));
  const notice = sent.find((s) => typeof s.message === 'string' && s.message.startsWith('画失败了'));
  check('失败后发了通知', !!notice, JSON.stringify(sent.map((s) => s.message)));
  check('通知里带原因', !!notice && notice.message.includes('504'), String(notice?.message).slice(0, 60));
  check('失败也报备了用量', usage.some((u) => u.ok === false), JSON.stringify(usage.map((u) => u.ok)));
}

// ── 汇总 ─────────────────────────────────────────────────────
let bad = 0;
for (const r of results) {
  if (!r.pass) bad += 1;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.pass ? '  → ' + r.detail : ''}`);
}
console.log(`\n${results.length - bad}/${results.length} 通过${bad ? `，${bad} 项失败` : '，全部通过'}`);
process.exit(bad ? 1 : 0);
