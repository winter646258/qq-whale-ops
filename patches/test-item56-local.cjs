// test-item56-local.cjs
// 从补丁后的 bridge.js 里「原样抽出」被改的函数，在 vm 里用桩跑。
// 不重写逻辑 —— 抽的就是要上线的那些行，这样测的是真代码。
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync('bridge-patched.js', 'utf8');

function extractFunction(name) {
  const sig = `function ${name}(`;
  const at = SRC.indexOf(sig);
  if (at < 0) throw new Error('找不到函数 ' + name);
  // 先跳过参数表（默认值里可能有 {}），参数表外的第一个 { 才是函数体
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

function extractConst(name) {
  const sig = `const ${name} = `;
  const at = SRC.indexOf(sig);
  if (at < 0) throw new Error('找不到常量 ' + name);
  let i = SRC.indexOf(';', at);
  return SRC.slice(at, i + 1);
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
function makeSandbox() {
  const convs = new Map();
  const wakes = [];
  const logs = [];
  const timers = [];
  const env = {
    convs,
    wakes,
    logs,
    timers,
    getSocialV2State(key) {
      if (!convs.has(key)) convs.set(key, { unread: [], pendingWakeReasons: [] });
      return convs.get(key);
    },
    isConversationBusyV2: (key) => Boolean(env.busyKeys && env.busyKeys.has(key)),
    scheduleWakeV2: (key, reason) => wakes.push({ key, reason }),
    saveSocialV2State: () => { env.saves += 1; },
    socialV2: { conversations: convs, paused: false },
    cfg: { socialV2: { enabled: true, proactive: { checkIntervalMinMs: 30 * 60 * 1000, checkIntervalMaxMs: 90 * 60 * 1000 } } },
    currentMode: 'reserved2',
    proactiveAllowed: () => true,
    busyKeys: new Set(),
    saves: 0,
    setTimeout: (fn, delay) => { timers.push(delay); return { unref() {} }; },
    Date,
    log: (m) => logs.push(String(m)),
  };
  env.sandbox = env;
  return env;
}

const CODE = [
  extractConst('WAKE_PRIORITY'),
  extractFunction('wakePriorityV2'),
  extractConst('PENDING_WAKE_MAX'),
  extractConst('PENDING_WAKE_TTL_MS'),
  extractFunction('enqueuePendingWake'),
  extractFunction('pickPendingWakeIndex'),
  extractFunction('drainPendingWakeFor'),
  extractFunction('sweepPendingWakeReasons'),
  extractFunction('scheduleProactiveCheckV2'),
].join('\n\n');

function boot(overrides = {}) {
  const env = makeSandbox();
  Object.assign(env, overrides);
  const ctx = vm.createContext(env);
  vm.runInContext(CODE, ctx);
  return { env, ctx };
}

// ══════════════════════════════════════════════════════════
// A. 优先级排队
// ══════════════════════════════════════════════════════════
{
  const { env, ctx } = boot();
  const key = 'private:1124721191';
  const st = env.getSocialV2State(key);

  // 低优先级先进、高优先级后进
  ctx.enqueuePendingWake(st, 'probability', 1);
  ctx.enqueuePendingWake(st, 'anyMessage', 2);
  ctx.enqueuePendingWake(st, 'atMention', 3);
  ctx.enqueuePendingWake(st, 'private', 4);

  eq(st.pendingWakeReasons.length, 4, 'A1 四条都入队');
  const idx = ctx.pickPendingWakeIndex(st);
  eq(st.pendingWakeReasons[idx].reason, 'private', 'A2 出队取最高优先级 private');
  eq(st.pendingWakeReasons[idx].seq, 4, 'A3 取到的是 seq4');

  // 同优先级先入先出
  const st2 = env.getSocialV2State('k2');
  ctx.enqueuePendingWake(st2, 'atMention', 10);
  ctx.enqueuePendingWake(st2, 'atMention', 11);
  eq(st2.pendingWakeReasons[ctx.pickPendingWakeIndex(st2)].seq, 10, 'A4 同优先级先入先出');

  // 重复入队去重
  const before = st2.pendingWakeReasons.length;
  ctx.enqueuePendingWake(st2, 'atMention', 10);
  eq(st2.pendingWakeReasons.length, before, 'A5 同 reason+seq 去重');

  // 数字 seq 归一
  const st3 = env.getSocialV2State('k3');
  ctx.enqueuePendingWake(st3, 'keyword', '7');
  eq(st3.pendingWakeReasons[0].seq, 7, 'A6 字符串 seq 归一成数字');
  ok(typeof st3.pendingWakeReasons[0].at === 'number' && st3.pendingWakeReasons[0].at > 0, 'A7 入队打时间戳');
  eq(st3.pendingWakeReasons[0].pr, 60, 'A8 入队缓存优先级 keyword=60');
}

// ══════════════════════════════════════════════════════════
// B. 队列满：丢最低优先级，而不是丢最早的
// ══════════════════════════════════════════════════════════
{
  const { env, ctx } = boot();
  const st = env.getSocialV2State('k');
  // 先塞 20 条 high
  for (let i = 1; i <= 20; i += 1) ctx.enqueuePendingWake(st, 'private', i);
  eq(st.pendingWakeReasons.length, 20, 'B1 满 20 条');
  const seqsBefore = st.pendingWakeReasons.map((r) => r.seq).sort((a, b) => a - b);
  eq(seqsBefore[0], 1, 'B2 满时 seq1 还在');

  // 再来一条低优先级：应被立刻丢弃（因为它是最低的）——队列不变
  ctx.enqueuePendingWake(st, 'probability', 99);
  eq(st.pendingWakeReasons.length, 20, 'B3 低优先级进满队列后长度不变');
  ok(!st.pendingWakeReasons.some((r) => r.reason === 'probability'), 'B4 新来的最低优先级被丢');

  // 再来一条高优先级：应挤掉一条已有的高优先级（同优先级丢最早）
  ctx.enqueuePendingWake(st, 'private', 21);
  eq(st.pendingWakeReasons.length, 20, 'B5 高优先级进满队列挤掉一条');
  ok(st.pendingWakeReasons.some((r) => r.seq === 21), 'B6 新来的 seq21 在队列里');
  ok(!st.pendingWakeReasons.some((r) => r.seq === 1), 'B7 挤掉的是最早的同优先级 seq1');
}

// ══════════════════════════════════════════════════════════
// C. 出队补发
// ══════════════════════════════════════════════════════════
{
  const { env, ctx } = boot();
  const key = 'private:2050117833';
  const st = env.getSocialV2State(key);
  st.unread = [{ seq: 24, text: 'a' }, { seq: 25, text: 'b' }];
  ctx.enqueuePendingWake(st, 'probability', 24);
  ctx.enqueuePendingWake(st, 'private', 25);

  // 忙：不出队、不放回丢数据
  env.busyKeys.add(key);
  const r1 = ctx.drainPendingWakeFor(key);
  eq(r1, false, 'C1 忙时不补发');
  eq(st.pendingWakeReasons.length, 2, 'C2 忙时队列原样保留');

  // 不忙：先补 private
  env.busyKeys.delete(key);
  const r2 = ctx.drainPendingWakeFor(key);
  eq(r2, true, 'C3 不忙时补发成功');
  eq(env.wakes.length, 1, 'C4 只唤醒一次');
  eq(env.wakes[0].reason, 'private', 'C5 先补高优先级 private');
  eq(st.pendingWakeReasons.length, 1, 'C6 队列剩一条');

  // 第二条的消息已被读完：跳过不补
  st.unread = [];
  const r3 = ctx.drainPendingWakeFor(key);
  eq(r3, false, 'C7 消息已被处理则跳过');
  eq(env.wakes.length, 1, 'C8 不产生多余唤醒');
  eq(st.pendingWakeReasons.length, 0, 'C9 跳过的那条也已出队');

  // 过期条目跳过
  const st2 = env.getSocialV2State('k2');
  st2.unread = [{ seq: 5 }];
  st2.pendingWakeReasons = [{ reason: 'atMention', seq: 5, at: Date.now() - 31 * 60 * 1000, pr: 90 }];
  eq(ctx.drainPendingWakeFor('k2'), false, 'C10 超过 30 分钟不再补发');
  ok(env.logs.some((l) => l.includes('已过期')), 'C11 过期有日志');

  // 空队列
  eq(ctx.drainPendingWakeFor('empty'), false, 'C12 空队列返回 false');
  // 旧格式字符串残留不炸
  const st3 = env.getSocialV2State('k3');
  st3.pendingWakeReasons = ['legacy'];
  eq(ctx.drainPendingWakeFor('k3'), false, 'C13 旧格式残留被安全丢弃');
}

// ══════════════════════════════════════════════════════════
// D. 巡检
// ══════════════════════════════════════════════════════════
{
  const { env, ctx } = boot();
  const a = env.getSocialV2State('a');
  const b = env.getSocialV2State('b');
  a.unread = [{ seq: 3 }];
  ctx.enqueuePendingWake(a, 'atMention', 3);
  b.unread = [{ seq: 9 }];
  ctx.enqueuePendingWake(b, 'atMention', 9);
  b.pendingWakeReasons[0].at = Date.now() - 60 * 60 * 1000; // 过期

  env.busyKeys.add('a');
  ctx.sweepPendingWakeReasons();
  eq(env.wakes.length, 0, 'D1 两个会话都处理不了（a 忙 / b 过期）');
  eq(b.pendingWakeReasons.length, 0, 'D2 过期的被清掉');

  env.busyKeys.delete('a');
  ctx.sweepPendingWakeReasons();
  eq(env.wakes.length, 1, 'D3 a 不忙后补发');
  eq(env.wakes[0].key, 'a', 'D4 补发的是 a');

  // 暂停 / 非 reserved2 模式不动
  const s2 = boot();
  const c = s2.env.getSocialV2State('c');
  c.unread = [{ seq: 1 }];
  s2.ctx.enqueuePendingWake(c, 'private', 1);
  s2.env.socialV2.paused = true;
  s2.ctx.sweepPendingWakeReasons();
  eq(s2.env.wakes.length, 0, 'D5 paused 时不动');
  s2.env.socialV2.paused = false;
  s2.env.currentMode = 'normal';
  s2.ctx.sweepPendingWakeReasons();
  eq(s2.env.wakes.length, 0, 'D6 非 reserved2 模式不动');

  // socialV2 关闭
  const s3 = boot();
  const d = s3.env.getSocialV2State('d');
  d.unread = [{ seq: 1 }];
  s3.ctx.enqueuePendingWake(d, 'private', 1);
  s3.env.cfg.socialV2.enabled = false;
  s3.ctx.sweepPendingWakeReasons();
  eq(s3.env.wakes.length, 0, 'D7 socialV2.enabled=false 时不动');
}

// ══════════════════════════════════════════════════════════
// E. 主动档期持久化
// ══════════════════════════════════════════════════════════
{
  const MIN = 30 * 60 * 1000;
  const MAX = 90 * 60 * 1000;

  // E1 没存档期：随机落在 [min,max]
  const { env, ctx } = boot();
  const st = env.getSocialV2State('private:9001');
  ctx.scheduleProactiveCheckV2('private:9001');
  const d1 = env.timers[0];
  ok(d1 >= MIN && d1 <= MAX, `E1 首次随机档期在区间内 (${Math.round(d1 / 60000)}min)`);
  ok(st.proactiveNextAt > Date.now(), 'E2 档期已写入 st');
  ok(env.saves >= 1, 'E3 首排会落盘');
  eq(st.proactiveTimer === null || typeof st.proactiveTimer === 'object', true, 'E4 定时器已挂');

  // E5 已有存档期（还剩 12 分钟）：按剩余时间续，不重抽
  const s2 = boot();
  const st2 = s2.env.getSocialV2State('private:9002');
  st2.proactiveNextAt = Date.now() + 12 * 60 * 1000;
  s2.ctx.scheduleProactiveCheckV2('private:9002');
  const d2 = s2.env.timers[0];
  eq(Math.round(d2 / 60000), 12, 'E5 续档到剩余 12 分钟');

  // E6 存档期已过：重抽随机
  const s3 = boot();
  const st3 = s3.env.getSocialV2State('private:9003');
  st3.proactiveNextAt = Date.now() - 5 * 60 * 1000;
  s3.ctx.scheduleProactiveCheckV2('private:9003');
  const d3 = s3.env.timers[0];
  ok(d3 >= MIN && d3 <= MAX, `E6 过期档期重抽 (${Math.round(d3 / 60000)}min)`);

  // E7 远档被夹到 max*2
  const s4 = boot();
  const st4 = s4.env.getSocialV2State('private:9004');
  st4.proactiveNextAt = Date.now() + 10 * 60 * 60 * 1000;
  s4.ctx.scheduleProactiveCheckV2('private:9004');
  eq(s4.env.timers[0], MAX * 2, 'E7 过远的档期夹到 max*2');

  // E8 skipSave 时不落盘（load 期间用）
  const s5 = boot();
  s5.env.getSocialV2State('private:9005');
  s5.ctx.scheduleProactiveCheckV2('private:9005', { skipSave: true });
  eq(s5.env.saves, 0, 'E8 skipSave 时不落盘');
  ok(s5.env.timers.length === 1, 'E9 skipSave 仍会挂定时器');

  // E10 已有定时器不重复挂
  const s6 = boot();
  const st6 = s6.env.getSocialV2State('private:9006');
  st6.proactiveTimer = { fake: true };
  s6.ctx.scheduleProactiveCheckV2('private:9006');
  eq(s6.env.timers.length, 0, 'E10 已有定时器就不重复排');
}

// ══════════════════════════════════════════════════════════
// F. poke 判定（直接抽 handlePokeNotice 里的判定表达式验证）
// ══════════════════════════════════════════════════════════
{
  ok(SRC.includes("const pokedMe = targetIsSelf || (kind === 'private' && !targetId);"), 'F1 poke 判定表达式已写入');
  ok(SRC.includes('} else if (!pokedMe) {'), 'F2 非她本人时不唤醒');
  ok(SRC.includes("拍一拍目标不是她"), 'F3 有「只记录不唤醒」日志');
  ok(!SRC.includes('可能拍了你，也可能拍了别人'), 'F4 旧文案已清除');
  ok(SRC.includes('有人拍了一拍你'), 'F5 新文案已写入');

  // 表达式行为
  const decide = new Function('targetIsSelf', 'kind', 'targetId', "return targetIsSelf || (kind === 'private' && !targetId);");
  eq(decide(true, 'group', '999'), true, 'F6 群里拍到她 → 唤醒');
  eq(decide(false, 'group', '999'), false, 'F7 群里拍别人 → 不唤醒');
  eq(decide(false, 'group', ''), false, 'F8 群里没给 target → 保守不唤醒');
  eq(decide(false, 'private', ''), true, 'F9 私聊无 target → 视为拍她');
  eq(decide(true, 'private', 'x'), true, 'F10 私聊 targetIsSelf → 唤醒');
}

// ══════════════════════════════════════════════════════════
// G. 落盘字段
// ══════════════════════════════════════════════════════════
{
  const saveBody = extractFunction('saveSocialV2State');
  ok(saveBody.includes('pendingWakeReasons:'), 'G1 save 写 pendingWakeReasons');
  ok(saveBody.includes('proactiveNextAt:'), 'G2 save 写 proactiveNextAt');
  const loadBody = extractFunction('loadSocialV2State');
  ok(loadBody.includes('pendingWakeReasons:'), 'G3 load 读 pendingWakeReasons');
  ok(loadBody.includes('proactiveNextAt:'), 'G4 load 读 proactiveNextAt');
  ok(loadBody.includes('{ skipSave: true }'), 'G5 load 内调度传 skipSave');
  const clearBody = extractFunction('clearSocialV2Timers');
  ok(clearBody.includes('st.proactiveNextAt = 0'), 'G6 清定时器同时清档期');

  // load 的映射逻辑：用真代码片段跑一遍
  const mapCode = `
    var val = { pendingWakeReasons: [
      { reason: 'private', seq: 4, at: 111, pr: 100 },
      { reason: 'keyword', seq: '9' },
      'garbage',
      null
    ], proactiveNextAt: '1750000000000' };
    var out = {
      pendingWakeReasons: Array.isArray(val.pendingWakeReasons)
        ? val.pendingWakeReasons
          .filter((r) => r && typeof r === 'object' && typeof r.reason === 'string')
          .map((r) => ({ reason: r.reason, seq: Number(r.seq) || 0, at: Number(r.at) || 0, pr: Number(r.pr) > 0 ? Number(r.pr) : 0 }))
          .slice(-20)
        : [],
      proactiveNextAt: Number(val.proactiveNextAt) > 0 ? Number(val.proactiveNextAt) : 0
    };
  `;
  const mini = vm.createContext({
    wakePriorityV2: (() => {
      const c = vm.createContext({});
      vm.runInContext(extractConst('WAKE_PRIORITY') + '\n' + extractFunction('wakePriorityV2'), c);
      return c.wakePriorityV2;
    })(),
  });
  vm.runInContext(mapCode, mini);
  const out = mini.out;
  eq(out.pendingWakeReasons.length, 2, 'G7 脏数据被过滤，只留两条');
  eq(out.pendingWakeReasons[0], { reason: 'private', seq: 4, at: 111, pr: 100 }, 'G8 完整字段原样保留');
  eq(out.pendingWakeReasons[1].seq, 9, 'G9 字符串 seq 归一');
  eq(out.pendingWakeReasons[1].at, 0, 'G10 缺 at 补 0');
  eq(out.pendingWakeReasons[1].pr, 0, 'G11 缺 pr 补 0（不在 load 里查表，避免 TDZ）');
  eq(out.proactiveNextAt, 1750000000000, 'G12 字符串档期归一成数字');
  eq((() => { const m = vm.createContext({ wakePriorityV2: mini.wakePriorityV2 }); vm.runInContext(mapCode.replace("pendingWakeReasons: [", "pendingWakeReasons: undefined, _x: ["), m); return m.out.pendingWakeReasons; })(), [], 'G13 非数组回落空数组');
}

// ══════════════════════════════════════════════════════════
// H. 结构完整性
// ══════════════════════════════════════════════════════════
{
  ok(SRC.includes('setInterval(sweepPendingWakeReasons, 30_000)'), 'H1 启动巡检已挂');
  ok(SRC.includes('enqueuePendingWake(st, reason, seq);'), 'H2 入队调用已替换');
  eq(SRC.split('enqueuePendingWake(st, reason, seq);').length - 1, 2, 'H3 两处繁忙入口都改了');
  ok(!SRC.includes('st.pendingWakeReasons.push({ reason, seq });'), 'H4 旧 FIFO 入队已消失');
  eq(SRC.split('drainPendingWakeFor(key);').length - 1, 2, 'H5 出队与巡检各调一次');
  ok(!SRC.includes('stEnd.pendingWakeReasons.shift()'), 'H6 旧出队已消失');
}

// ── I. pr=0 的条目按 reason 现算优先级 ──
{
  const { env, ctx } = boot();
  const st = env.getSocialV2State('k');
  st.pendingWakeReasons = [
    { reason: 'probability', seq: 1, at: 1, pr: 0 },
    { reason: 'private', seq: 2, at: 2, pr: 0 },
    { reason: 'keyword', seq: 3, at: 3, pr: 0 },
  ];
  const idx = ctx.pickPendingWakeIndex(st);
  eq(st.pendingWakeReasons[idx].reason, 'private', 'I1 pr=0 时按 reason 现算，private 排第一');
  const st2 = env.getSocialV2State('k2');
  for (let i = 1; i <= 20; i += 1) ctx.enqueuePendingWake(st2, 'private', i);
  st2.pendingWakeReasons.forEach((r) => { r.pr = 0; });
  ctx.enqueuePendingWake(st2, 'probability', 99);
  ok(!st2.pendingWakeReasons.some((r) => r.seq === 99), 'I2 pr 全为 0 时仍能按 reason 判断该丢谁');
}

// ── 结果 ───────────────────────────────────────────────────
console.log(`\n通过 ${pass} 条，失败 ${fails.length} 条`);
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach((f) => console.log('  ✖', f));
  process.exit(1);
}
console.log('全部通过');
