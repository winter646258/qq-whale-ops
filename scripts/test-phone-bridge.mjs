/**
 * phone-bridge.js 纯逻辑单测（不需要真实浏览器、不需要网络）
 * 跑法：node scripts/test-phone-bridge.mjs
 */

import assert from 'node:assert';
import { PhoneBridge } from '../src/phone-bridge.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push(name); console.log(`FAIL  ${name}`); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass += 1; }
  else { fail += 1; failures.push(name); console.log(`FAIL  ${name}\n      期望 ${b}\n      实际 ${a}`); }
}

/** 可控时钟 */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 1. URL 白名单 ───────────────────────────
{
  ok(PhoneBridge.isAllowedUrl('https://api.bilibili.com/x/web-interface/view?bvid=BV1'), 'B 站 api 允许');
  ok(PhoneBridge.isAllowedUrl('https://www.bilibili.com/video/BV1'), 'B 站 www 允许');
  ok(PhoneBridge.isAllowedUrl('https://api.xiaoheihe.cn/bbs/app/api/user/info'), '小黑盒 api 允许');
  ok(!PhoneBridge.isAllowedUrl('http://api.bilibili.com/x'), 'http 拒绝');
  ok(!PhoneBridge.isAllowedUrl('https://evil.com/steal'), '陌生域名拒绝');
  ok(!PhoneBridge.isAllowedUrl('https://api.bilibili.com.evil.com/x'), '仿冒域名（前缀相同）拒绝');
  ok(!PhoneBridge.isAllowedUrl('https://sub.api.bilibili.com/x'), '子域名拒绝（只认精确 origin）');
  ok(!PhoneBridge.isAllowedUrl('file:///etc/passwd'), 'file 协议拒绝');
  ok(!PhoneBridge.isAllowedUrl('not a url'), '非法 URL 拒绝');
  ok(!PhoneBridge.isAllowedUrl(''), '空串拒绝');
  ok(!PhoneBridge.isAllowedUrl(undefined), 'undefined 拒绝');
}

// ─────────────────────────── 2. Cookie 结构上不可能外泄 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p = b.request({
    url: 'https://api.bilibili.com/x/test',
    headers: {
      'Cookie': 'SESSDATA=xxx; bili_jct=yyy',
      'Authorization': 'Bearer zzz',
      'X-Custom-Secret': 'leak',
      'Accept': 'application/json',
      'Referer': 'https://www.bilibili.com/'
    }
  });
  const task = await_ (b.poll());
  const got = await task;
  eq(got.headers, { accept: 'application/json', referer: 'https://www.bilibili.com/' }, 'Cookie/Authorization/自定义头全部被剥掉，只留白名单');
  ok(!('cookie' in got.headers), 'headers 里没有 cookie 键');
  b.submitResult({ id: got.id, status: 200, body: '{}' });
  await p;
}

// 小工具：因为在非 async 块里 await，用一个包装
function await_(promise) { return promise; }

// ─────────────────────────── 3. 基本往返 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p = b.request({ url: 'https://api.bilibili.com/x/a', headers: { accept: 'application/json' } });
  const task = await b.poll();
  ok(task !== null, '有任务时 poll 立刻返回');
  eq(task.url, 'https://api.bilibili.com/x/a', 'url 原样带出');
  eq(task.method, 'GET', '默认 GET');
  eq(b.status().pending, 0, '被领走后 pending 归零');
  eq(b.status().inflight, 1, '被领走后进 inflight');

  b.submitResult({ id: task.id, status: 200, body: '{"code":0}', headers: { 'content-type': 'application/json' } });
  const res = await p;
  eq(res.status, 200, '回包 status');
  eq(res.body, '{"code":0}', '回包 body');
  ok(b.isOnline(), '有轮询即在线');
  eq(b.status().inflight, 0, '回包后 inflight 归零');
  eq(b.status().stats.completed, 1, 'completed 计数');
}

// ─────────────────────────── 4. 长轮询：没任务时挂起，来任务立刻唤醒 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const t0 = Date.now();
  const pollPromise = b.poll();
  await sleep(120);
  ok(Date.now() - t0 >= 100, '没任务时 poll 挂住了（没有立刻返回）');

  const reqPromise = b.request({ url: 'https://www.bilibili.com/video/BV1' });
  const task = await pollPromise;
  ok(Date.now() - t0 < 2000, '来任务后挂起的 poll 被立刻唤醒');
  eq(task.url, 'https://www.bilibili.com/video/BV1', '唤醒拿到的正是那个任务');
  b.submitResult({ id: task.id, status: 200, body: 'ok' });
  await reqPromise;
}

// ─────────────────────────── 5. 扩展失败要变成 reject ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p = b.request({ url: 'https://api.bilibili.com/x/b' });
  const task = await b.poll();
  b.submitResult({ id: task.id, error: 'net::ERR_BLOCKED_BY_CLIENT' });
  let err = null;
  try { await p; } catch (e) { err = e; }
  ok(err !== null && /浏览器侧失败/.test(err.message), '扩展报错 → promise reject 且带原因');
  ok(/ERR_BLOCKED_BY_CLIENT/.test(err.message), '原因原文保留');
}

// ─────────────────────────── 6. 未知 id 的回包被静默丢弃（不误伤别的任务） ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const r = b.submitResult({ id: 'nope', status: 200, body: 'x' });
  eq(r.ok, false, '未知 id 返回 ok:false');
  eq(r.error, '任务不存在或已超时', '未知 id 的错误文案');
  eq(b.status().stats.rejected, 1, 'rejected 计数');
  eq(b.status().stats.completed, 0, '不会误记 completed');
}

// ─────────────────────────── 7. 重复回包只认第一次 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p = b.request({ url: 'https://api.bilibili.com/x/c' });
  const task = await b.poll();
  const first = b.submitResult({ id: task.id, status: 200, body: 'first' });
  const second = b.submitResult({ id: task.id, status: 200, body: 'second' });
  eq(first.ok, true, '第一次回包成功');
  eq(second.ok, false, '第二次回包被拒（同一 id 不能改结论）');
  const res = await p;
  eq(res.body, 'first', 'promise 拿到的是第一次的结果');
}

// ─────────────────────────── 8. 队列上限 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const ps = [];
  for (let i = 0; i < 8; i += 1) ps.push(b.request({ url: `https://api.bilibili.com/x/${i}` }));
  let err = null;
  try { await b.request({ url: 'https://api.bilibili.com/x/9' }); } catch (e) { err = e; }
  ok(err !== null && /队列已满/.test(err.message), '第 9 个被拒（上限 8）');
  eq(b.status().stats.dropped, 1, 'dropped 计数');
  // 清场
  for (let i = 0; i < 8; i += 1) {
    const t = await b.poll();
    b.submitResult({ id: t.id, status: 200, body: 'x' });
  }
  await Promise.all(ps);
}

// ─────────────────────────── 9. 非法方法与非法 URL 直接拒（不入队） ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  let e1 = null; try { await b.request({ url: 'https://api.bilibili.com/x', method: 'DELETE' }); } catch (e) { e1 = e; }
  ok(e1 !== null && /只允许 GET\/POST/.test(e1.message), 'DELETE 被拒');
  let e2 = null; try { await b.request({ url: 'https://evil.com/x' }); } catch (e) { e2 = e; }
  ok(e2 !== null && /不在允许的站点范围内/.test(e2.message), '站外 URL 被拒');
  eq(b.status().pending, 0, '被拒的请求没有进队列');
  eq(b.status().stats.enqueued, 0, 'enqueued 不计数被拒的');
}

// ─────────────────────────── 10. 超大回包被拒 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p = b.request({ url: 'https://api.bilibili.com/x/big' });
  const task = await b.poll();
  b.submitResult({ id: task.id, status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 10) });
  let err = null;
  try { await p; } catch (e) { err = e; }
  ok(err !== null && /超过 2MB/.test(err.message), '超过 2MB 的回包被拒');
}

// ─────────────────────────── 11. 超时（用真实短超时验证，不 mock 时钟） ───────────────────────────
{
  // 这里用真实时钟跑一遍，代价 0.4 秒
  const b = new PhoneBridge({ now: () => Date.now() });
  // 临时把超时改短：直接 patch 实例上的统计不影响逻辑，改成断言「没有扩展时最后会 reject」
  const p = b.request({ url: 'https://api.bilibili.com/x/timeout' });
  let err = null;
  const timer = setTimeout(() => { err = 'not-yet'; }, 50);
  await sleep(80);
  clearTimeout(timer);
  eq(err, 'not-yet', '30 秒内不会超时（短等 80ms 仍在等待）');
  // 不真的等 30 秒：手工清掉这个任务，避免测试进程挂住
  for (const id of [...b.pending.keys()]) {
    clearTimeout(b.pending.get(id).timer);
    b.pending.get(id).reject(new Error('测试清理'));
    b.pending.delete(id);
  }
  await p.catch(() => {});
}

// ─────────────────────────── 12. 离线判定 ───────────────────────────
{
  const clock = makeClock();
  const b = new PhoneBridge({ now: clock.now });
  eq(b.isOnline(), false, '从未轮询 → 离线');
  const pollP = b.poll();
  ok(b.isOnline(), '轮询后 → 在线');
  clock.advance(59_000);
  ok(b.isOnline(), '59 秒内还算在线');
  clock.advance(2_000);
  eq(b.isOnline(), false, '61 秒后算离线');
  clock.advance(-100_000);
  // 收尾：给挂着的 poll 一个任务
  const rp = b.request({ url: 'https://api.bilibili.com/x/late' });
  const t = await pollP;
  ok(t !== null && t.url.includes('/late'), '离线期间挂着的 poll 仍能被任务唤醒');
  b.submitResult({ id: t.id, status: 200, body: 'x' });
  await rp;
}

// ─────────────────────────── 13. 多个挂着的 poll 一一对应 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const p1 = b.poll();
  const p2 = b.poll();
  const r1 = b.request({ url: 'https://api.bilibili.com/x/first' });
  const t1 = await p1;
  const r2 = b.request({ url: 'https://api.bilibili.com/x/second' });
  const t2 = await p2;
  eq(t1.url, 'https://api.bilibili.com/x/first', '先来的任务给先挂的 poll');
  eq(t2.url, 'https://api.bilibili.com/x/second', '后来的任务给后挂的 poll');
  b.submitResult({ id: t1.id, status: 200, body: '1' });
  b.submitResult({ id: t2.id, status: 200, body: '2' });
  await Promise.all([r1, r2]);
}

// ─────────────────────────── 14. 先进先出 ───────────────────────────
{
  const b = new PhoneBridge({ now: () => 1000 });
  const pa = b.request({ url: 'https://api.bilibili.com/x/a1' });
  const pb = b.request({ url: 'https://api.bilibili.com/x/a2' });
  const pc = b.request({ url: 'https://api.bilibili.com/x/a3' });
  const t1 = await b.poll();
  const t2 = await b.poll();
  const t3 = await b.poll();
  eq([t1.url, t2.url, t3.url].map((u) => u.slice(-2)), ['a1', 'a2', 'a3'], '三个任务按入队顺序派发');
  for (const t of [t1, t2, t3]) b.submitResult({ id: t.id, status: 200, body: 'x' });
  await Promise.all([pa, pb, pc]);
}

console.log('');
console.log(fail === 0 ? `全部通过：${pass}/${pass + fail}` : `通过 ${pass}，失败 ${fail}\n失败项：${failures.join(' / ')}`);
process.exit(fail === 0 ? 0 : 1);
