#!/usr/bin/env node
// 单测：tts-gc.js + batch-window.js
// 纯函数直接测；gcTtsDir 用假 fs 注入。
import { planTtsGc, tsFromTtsName, isSafeTtsFileName, gcTtsDir, TTS_GC_DEFAULTS } from '../src/tts-gc.js';
import { resolveBatchPolicy, planBatchWindow, decideRearm, BATCH_DEFAULTS } from '../src/batch-window.js';

let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass += 1; console.log(`  ok  ${msg}`); }
  else { fail += 1; console.log(`  FAIL ${msg}\n       实得=${JSON.stringify(a)}\n       期望=${JSON.stringify(b)}`); }
};
const ok = (v, msg) => eq(Boolean(v), true, msg);
const group = (t) => console.log(`\n【${t}】`);

// ── tts-gc ──────────────────────────────────────────────
group('tsFromTtsName');
eq(tsFromTtsName('tts-1730000000000-abc123.wav'), 1730000000000, '正常名取到时间戳');
eq(tsFromTtsName('tts-1730000000000-abc123.WAV'), 1730000000000, '大写扩展名也认');
eq(tsFromTtsName('banner.png'), 0, '非 tts 名返回 0');
eq(tsFromTtsName('tts-abc-def.wav'), 0, '时间戳不是数字返回 0');
eq(tsFromTtsName(''), 0, '空串返回 0');
eq(tsFromTtsName(null), 0, 'null 返回 0');

group('isSafeTtsFileName');
ok(isSafeTtsFileName('tts-1730000000000-abc123.wav'), '正常名通过');
ok(!isSafeTtsFileName('../etc/passwd'), '路径穿越拒绝');
ok(!isSafeTtsFileName('tts-1-a.wav/../x'), '带斜杠拒绝');
ok(!isSafeTtsFileName('tts-1-a.wav\\x'), '反斜杠拒绝');
ok(!isSafeTtsFileName('.hidden'), '点开头拒绝');
ok(!isSafeTtsFileName(''), '空串拒绝');
ok(!isSafeTtsFileName('我的语音.wav'), '非 tts 前缀拒绝');

group('planTtsGc —— 天数');
{
  const now = 1_800_000_000_000;
  const day = 86400000;
  const files = [
    { name: 'tts-1-aa.wav', mtimeMs: now - 1 * day, size: 100 },
    { name: 'tts-2-bb.wav', mtimeMs: now - 5 * day, size: 200 },
    { name: 'tts-3-cc.wav', mtimeMs: now - 10 * day, size: 300 },
    { name: 'tts-4-dd.wav', mtimeMs: now - 30 * day, size: 400 },
  ];
  // keepRecent 设 0 才能干净地只测天数
  const r = planTtsGc(files, { now, keepDays: 7, keepMax: 0, keepRecent: 0, minAgeMs: 0 });
  eq(r.remove.map((x) => x.name).sort(), ['tts-3-cc.wav', 'tts-4-dd.wav'], '超过 7 天的删掉');
  eq(r.keepCount, 2, '留下 2 个');
  eq(r.removeBytes, 700, '删掉字节数正确');
  ok(r.remove.every((x) => /超过 7 天/.test(x.reason)), '原因是超天数');
}

group('planTtsGc —— keepRecent 保护最近几个');
{
  const now = 1_800_000_000_000;
  const day = 86400000;
  const files = [1, 2, 3, 4, 5].map((i) => ({
    name: `tts-${i}-x${i}.wav`,
    mtimeMs: now - i * 100 * day, // 全是老文件
    size: i,
  }));
  const r = planTtsGc(files, { now, keepDays: 7, keepMax: 0, keepRecent: 2, minAgeMs: 0 });
  eq(r.keepCount, 2, 'keepRecent=2 只留 2 个');
  eq(r.remove.length, 3, '另外 3 个删掉');
  // 留下的应该是最新的两个（at 最大）
  eq(r.remove.map((x) => x.name).sort(), ['tts-3-x3.wav', 'tts-4-x4.wav', 'tts-5-x5.wav'], '删的是最老的三个');
}

group('planTtsGc —— keepMax 数量上限');
{
  const now = 1_800_000_000_000;
  const files = Array.from({ length: 10 }, (_, i) => ({
    name: `tts-${i + 1}-a${i}.wav`,
    mtimeMs: now - i * 1000, // i=0 最新
    size: 10,
  }));
  const r = planTtsGc(files, { now, keepDays: 0, keepMax: 3, keepRecent: 0, minAgeMs: 0 });
  eq(r.keepCount, 3, '只留 3 个');
  eq(r.remove.length, 7, '删 7 个');
  ok(r.remove.every((x) => /数量超限/.test(x.reason)), '原因是数量超限');
}

group('planTtsGc —— minAgeMs 保护正在发送的');
{
  const now = 1_800_000_000_000;
  const files = [
    { name: 'tts-1-fresh.wav', mtimeMs: now - 1000, size: 10 },     // 1 秒前
    { name: 'tts-2-old.wav', mtimeMs: now - 3600_000, size: 10 },   // 1 小时前
  ];
  const r = planTtsGc(files, { now, keepDays: 0.0001, keepMax: 0, keepRecent: 0, minAgeMs: 10 * 60 * 1000 });
  eq(r.remove.map((x) => x.name), ['tts-2-old.wav'], '只删 1 小时前的，1 秒前的留着');
}

group('planTtsGc —— keepDays=0 表示不按天数删');
{
  const now = 1_800_000_000_000;
  const files = [{ name: 'tts-1-a.wav', mtimeMs: now - 999 * 86400000, size: 1 }];
  const r = planTtsGc(files, { now, keepDays: 0, keepMax: 0, keepRecent: 0, minAgeMs: 0 });
  eq(r.remove.length, 0, 'keepDays=0 不因天数删');
}

group('planTtsGc —— 脏输入不炸');
eq(planTtsGc(null).remove, [], 'null 输入');
eq(planTtsGc([]).remove, [], '空数组');
eq(planTtsGc([{}]).remove, [], '缺字段的项被过滤');
// 时间戳取不到（at=0）时**刻意不按天数删** —— 不知道多老就别删，交给数量上限兜底
eq(planTtsGc([{ name: 'tts-1-a.wav', size: 5 }], { now: 1e15, keepDays: 1, keepRecent: 0, minAgeMs: 0 }).remove, [],
  'mtime 缺失不按天数删（不知道多老就不动）');
eq(planTtsGc([{ name: 'tts-1-a.wav', size: 5 }], { now: 1e15, keepDays: 1, keepMax: 0.0, keepRecent: 0, minAgeMs: 0 }).remove, [],
  'keepMax=0 同样不删');
{
  // 但数量超限时它照样会被删（数量上限是兜底）
  const r = planTtsGc(
    [{ name: 'tts-9-new.wav', mtimeMs: 1e15, size: 1 }, { name: 'tts-1-a.wav', mtimeMs: 0, size: 5 }],
    { now: 1e15, keepDays: 1, keepMax: 1, keepRecent: 0, minAgeMs: 0 },
  );
  eq(r.remove.map((x) => x.name), ['tts-1-a.wav'], 'at=0 排到最后，超数量上限被删');
  ok(/数量超限/.test(r.remove[0].reason), '原因是数量超限而不是超天数');
}

group('gcTtsDir —— 假 fs');
{
  const made = [];
  const fakeFs = {
    readdirSync: () => ['tts-1-a.wav', 'tts-2-b.wav', 'banner.png', '../evil.wav'],
    statSync: (p) => {
      if (p.endsWith('tts-1-a.wav')) return { isFile: () => true, mtimeMs: 1000, size: 11 };
      if (p.endsWith('tts-2-b.wav')) return { isFile: () => true, mtimeMs: 2000, size: 22 };
      return { isFile: () => true, mtimeMs: 3000, size: 33 };
    },
    unlinkSync: (p) => made.push(p),
  };
  const r = gcTtsDir('/x/audio/tts', { fs: fakeFs, now: 1e15, keepDays: 1, keepMax: 0, keepRecent: 0, minAgeMs: 0 });
  ok(r.ok, '返回 ok');
  eq(r.scanned, 2, '只扫到 2 个合法 tts 文件（png 和 evil 被过滤）');
  eq(r.removed, 2, '删了 2 个');
  eq(r.bytes, 33, '字节数 11+22');
  ok(made.every((p) => p.startsWith('/x/audio/tts/')), '删除路径都在 tts 目录内');
}

group('gcTtsDir —— 目录不存在不算错');
{
  const enoent = new Error('no such file');
  enoent.code = 'ENOENT';
  const fakeFs = { readdirSync: () => { throw enoent; }, statSync: () => null, unlinkSync: () => {} };
  const r = gcTtsDir('/nope', { fs: fakeFs });
  ok(r.ok, 'ENOENT 当成功');
  eq(r.scanned, 0, '扫到 0 个');
}

group('gcTtsDir —— dryRun 不删');
{
  let deleted = 0;
  const fakeFs = {
    readdirSync: () => ['tts-1-a.wav'],
    statSync: () => ({ isFile: () => true, mtimeMs: 1000, size: 5 }),
    unlinkSync: () => { deleted += 1; },
  };
  const r = gcTtsDir('/x/tts', { fs: fakeFs, dryRun: true, now: 1e15, keepDays: 1, keepRecent: 0, minAgeMs: 0 });
  eq(deleted, 0, 'dryRun 一个都没删');
  ok(r.plan && r.plan.remove.length === 1, 'plan 里有 1 个待删');
}

group('gcTtsDir —— 没传 fs 明确报错');
{
  const r = gcTtsDir('/x/tts', {});
  eq(r.ok, false, '不传 fs 返回 ok=false');
  ok(/需要传入 fs/.test(r.error), '错误信息说清原因');
}

// ── batch-window ────────────────────────────────────────
group('resolveBatchPolicy');
{
  eq(resolveBatchPolicy({ batchWindowMs: 12000 }).baseMs, 12000, '老键名 batchWindowMs 生效');
  eq(resolveBatchPolicy({ baseMs: 5000 }).baseMs, 5000, '新键名 baseMs 生效');
  eq(resolveBatchPolicy({ baseMs: 5000, batchWindowMs: 12000 }).baseMs, 5000, 'baseMs 优先于 batchWindowMs');
  eq(resolveBatchPolicy({}).baseMs, BATCH_DEFAULTS.baseMs, '空对象走默认 8000');
  eq(resolveBatchPolicy({ baseMs: 10 }).baseMs, 1000, '小于 1000 抬到 1000');
  eq(resolveBatchPolicy({ baseMs: 'abc' }).baseMs, BATCH_DEFAULTS.baseMs, '脏值走默认');
  eq(resolveBatchPolicy({ maxMs: 1000, baseMs: 20000 }).maxMs, 20000, 'maxMs 小于 baseMs 时抬到 baseMs');
  eq(resolveBatchPolicy({ extendOnNewMessage: false }).extendOnNewMessage, false, '能关掉延长');
  eq(resolveBatchPolicy(null).baseMs, BATCH_DEFAULTS.baseMs, 'null 输入走默认');
}

group('planBatchWindow');
{
  const policy = { baseMs: 8000, maxMs: 30000, extendOnNewMessage: true };
  // 单条消息，now == last
  const a = planBatchWindow({ firstAt: 1000, lastAt: 1000, now: 1000, policy });
  eq(a.deadline, 9000, '单条：1000+8000');
  eq(a.capped, false, '没封顶');
  // 窗口内又来一条，now=3000 last=3000
  const b = planBatchWindow({ firstAt: 1000, lastAt: 3000, now: 3000, policy });
  eq(b.deadline, 11000, '滑动到 3000+8000');
  // 一直刷：last 很大，被 first+maxMs 封住；而 now 已经过了封顶时刻 → 立刻发
  const c = planBatchWindow({ firstAt: 1000, lastAt: 50000, now: 50000, policy });
  eq(c.capAt, 31000, '封顶时刻 = first+30000');
  eq(c.capped, true, '标记封顶');
  ok(c.late, '已过封顶时刻，标记 late');
  eq(c.deadline, 50001, '已过封顶就立刻发（留 1ms）');
  // 正常封顶：还没到封顶时刻，等到 capAt
  const c2 = planBatchWindow({ firstAt: 1000, lastAt: 25000, now: 25000, policy });
  eq(c2.deadline, 31000, '未过封顶时等到 capAt');
  eq(c2.capped, true, 'c2 也封顶');
  // now 已经超过 deadline 时至少给 1ms
  const d = planBatchWindow({ firstAt: 1000, lastAt: 1000, now: 999999, policy });
  ok(d.delayMs >= 1, '延迟至少 1ms，不产生 0 延迟忙循环');
}

group('decideRearm');
{
  const policy = { baseMs: 8000, maxMs: 30000, extendOnNewMessage: true };
  // 当前 deadline 9000，now=3000 来了新消息 → 应重排到 11000
  const a = decideRearm({ currentDeadline: 9000, firstAt: 1000, lastAt: 3000, now: 3000, policy });
  eq(a.rearm, true, '新消息把窗口往后推');
  eq(a.deadline, 11000, '推到 11000');
  ok(/延长/.test(a.reason), '原因是延长');
  // 已经封顶且时间已过，新消息不该再推
  const b = decideRearm({ currentDeadline: 31000, firstAt: 1000, lastAt: 90000, now: 90000, policy });
  eq(b.rearm, false, '封顶且已过时刻不再重排');
  eq(b.reason, '已到上限，不再延后', '原因说明是上限');
  // 计算出的 deadline 比现在早（理论上不该发生），也不能提前
  const c = decideRearm({ currentDeadline: 20000, firstAt: 1000, lastAt: 1000, now: 1000, policy });
  eq(c.rearm, false, '只往后推不提前');
  eq(c.deadline, 20000, '保持原 deadline');
  // 关掉延长
  const off = decideRearm({
    currentDeadline: 9000, firstAt: 1000, lastAt: 5000, now: 5000,
    policy: { baseMs: 8000, maxMs: 30000, extendOnNewMessage: false },
  });
  eq(off.rearm, false, 'extendOnNewMessage=false 时不重排');
  eq(off.reason, '不延长', '原因是「不延长」');
  // 没有当前 deadline（首次）→ 应该建立
  const fresh = decideRearm({ currentDeadline: 0, firstAt: 5000, lastAt: 5000, now: 5000, policy });
  eq(fresh.rearm, true, '首次建立窗口');
  eq(fresh.deadline, 13000, '首次 deadline 正确');
}

group('decideRearm —— 真实刷屏场景');
{
  // 模拟：t=0 第一条，之后每 3 秒一条，共 20 条
  const policy = { baseMs: 8000, maxMs: 30000, extendOnNewMessage: true };
  let deadline = 0;
  let firstAt = 0;
  let rearms = 0;
  for (let i = 0; i < 20; i += 1) {
    const now = i * 3000;
    if (i === 0) firstAt = now;
    const d = decideRearm({ currentDeadline: deadline, firstAt, lastAt: now, now, policy });
    if (d.rearm) { deadline = d.deadline; rearms += 1; }
  }
  // t=0 建窗 → 8000；t=3000 → 11000；t=6000 → 14000；… 一直到 first+30000=30000 封顶
  eq(deadline, 30000, '最终停在上限 30000');
  ok(rearms > 1, '过程中确实重排过多次');
  ok(rearms <= 20, '不会无限重排');
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
