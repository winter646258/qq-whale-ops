// 情绪状态模块单测。用法：node mood-store.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decayValue, halfLifeFor, decayMood, normalizeState, createDefaultMood,
  readMood, writeMood, setMood, ventUndercurrent, resolveUndercurrent,
  undercurrentLoad, setAffinity, setBaseline, formatDuration,
  effectiveMood, describeBaseline, describeMood, moodStats,
  PAD_KEYS, HALF_LIFE_STRONG_MS, HALF_LIFE_MID_MS, HALF_LIFE_LIGHT_MS,
  STRONG_GAP, MID_GAP, UNDERCURRENT_ALERT, MAX_UNDERCURRENT,
  MAX_LABEL_CHARS, MAX_REASON_CHARS, MAX_VENT_CHARS,
  AFFINITY_MIN, AFFINITY_MAX, BASELINE_STEP_LIMIT, DEFAULT_BASELINE
} from './mood-store.js';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const eq = (l, a, b) => ok(l, a === b, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);
const near = (l, a, b, eps = 0.001) => ok(l, Math.abs(Number(a) - Number(b)) <= eps, `期望≈${b} 实际 ${a}`);
const throws = (l, fn) => { try { fn(); ok(l, false, '本应抛错'); } catch { ok(l, true); } };
const notThrows = (l, fn) => { try { fn(); ok(l, true); } catch (e) { ok(l, false, e.message); } };
const section = (t) => console.log(`\n=== ${t} ===`);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-21T19:00:00+08:00');

// ── 衰减数学 ───────────────────────────────────────────────────────────
section('衰减数学：指数回归');
{
  near('半衰期整好一半', decayValue(1, 0, 90 * MIN, 90 * MIN), 0.5);
  near('两个半衰期是四分之一', decayValue(1, 0, 180 * MIN, 90 * MIN), 0.25);
  near('零时间不变', decayValue(0.8, 0, 0, 90 * MIN), 0.8);
  near('负时间不变（时钟回退不放大情绪）', decayValue(0.8, 0, -5 * MIN, 90 * MIN), 0.8);
  near('已经归位就不动', decayValue(0.2, 0.2, 999 * MIN, 90 * MIN), 0.2);
  near('从负值回归', decayValue(-0.6, 0, 45 * MIN, 45 * MIN), -0.3);
  near('非数字 current 落到 baseline', decayValue(undefined, 0.3, MIN, 90 * MIN), 0.3);
  near('非法半衰期不衰减', decayValue(0.9, 0, MIN, 0), 0.9);
}

section('衰减的半群性质 —— 这就是不做定时器的理由');
{
  // 一次衰减 120 分钟，必须等于先 50 分钟再 70 分钟
  const oneShot = decayValue(1, 0, 120 * MIN, 90 * MIN);
  const step1 = decayValue(1, 0, 50 * MIN, 90 * MIN);
  const step2 = decayValue(step1, 0, 70 * MIN, 90 * MIN);
  near('两段拼起来等于一整段', step2, oneShot, 1e-9);

  // 再拆成 12 段 10 分钟
  let v = 1;
  for (let i = 0; i < 12; i += 1) v = decayValue(v, 0, 10 * MIN, 90 * MIN);
  near('拆成 12 段也一样（所以「每分钟 tick」没有额外信息量）', v, oneShot, 1e-9);
}

section('半衰期按偏离幅度分级');
{
  eq('偏离 0.8 是强档', halfLifeFor(0.8), HALF_LIFE_STRONG_MS);
  eq('偏离 0.4 是中档', halfLifeFor(0.4), HALF_LIFE_MID_MS);
  eq('偏离 0.1 是轻档', halfLifeFor(0.1), HALF_LIFE_LIGHT_MS);
  eq('边界 0.6 归中档（要严格大于）', halfLifeFor(STRONG_GAP), HALF_LIFE_MID_MS);
  eq('边界 0.3 归轻档', halfLifeFor(MID_GAP), HALF_LIFE_LIGHT_MS);
  eq('负偏离一样算幅度', halfLifeFor(-0.8), HALF_LIFE_STRONG_MS);
  eq('零偏离是轻档', halfLifeFor(0), HALF_LIFE_LIGHT_MS);
  ok('强档比轻档慢得多', HALF_LIFE_STRONG_MS > HALF_LIFE_LIGHT_MS * 4);
}

section('三维各自代谢');
{
  // pleasure 偏离 0.9（强档 90min），arousal 只偏离 0.1（轻档 20min）
  const state = {
    pad: { pleasure: 0.9, arousal: 0.1, dominance: 0 },
    baseline: { pleasure: 0, arousal: 0, dominance: 0 },
    updatedAt: T0
  };
  const after40 = decayMood(state, T0 + 40 * MIN);
  ok('40 分钟后 pleasure 还有一半以上（慢档）', after40.pleasure > 0.5, String(after40.pleasure));
  ok('40 分钟后 arousal 已经基本归位（快档）', after40.arousal < 0.03, String(after40.arousal));

  const after180 = decayMood(state, T0 + 180 * MIN);
  ok('180 分钟后 pleasure 也淡了', after180.pleasure < 0.3, String(after180.pleasure));
  ok('但比 arousal 剩得多', after180.pleasure > after180.arousal);
}

// ── 规范化 ─────────────────────────────────────────────────────────────
section('规范化容错');
{
  const d = createDefaultMood(T0);
  eq('默认版本号', d.version, 1);
  eq('默认 label 为空', d.label, '');
  eq('默认好感度从 1 开始', d.affinity.level, AFFINITY_MIN);
  eq('默认底色就是 DEFAULT_BASELINE', d.baseline.pleasure, DEFAULT_BASELINE.pleasure);
  eq('pad 初始等于底色', d.pad.pleasure, d.baseline.pleasure);

  const wild = normalizeState({
    pad: { pleasure: 5, arousal: -9, dominance: 'abc' },
    baseline: { pleasure: 2 },
    label: 'x'.repeat(80),
    reason: 'y'.repeat(300),
    undercurrent: [
      { text: '第一件', weight: 5 },
      { text: '', weight: 1 },
      null,
      { text: '第二件', weight: -3 }
    ],
    affinity: { level: 99, note: 'z'.repeat(300) }
  }, T0);
  eq('pleasure 钳到 1', wild.pad.pleasure, 1);
  eq('arousal 钳到 -1', wild.pad.arousal, -1);
  eq('dominance 非数字回落到 baseline', wild.pad.dominance, wild.baseline.dominance);
  eq('baseline 也钳制', wild.baseline.pleasure, 1);
  eq('label 截断', wild.label.length, MAX_LABEL_CHARS);
  eq('reason 截断', wild.reason.length, MAX_REASON_CHARS);
  eq('脏 undercurrent 被过滤（空文本 / null）', wild.undercurrent.length, 2);
  eq('weight 钳到 1', wild.undercurrent[0].weight, 1);
  eq('negative weight 钳到 0', wild.undercurrent[1].weight, 0);
  eq('好感度钳到上限', wild.affinity.level, AFFINITY_MAX);
  eq('note 截断', wild.affinity.note.length, 120);

  notThrows('null 也能规范化', () => normalizeState(null, T0));
  notThrows('数组也能规范化', () => normalizeState([], T0));
  eq('空对象的 since 落到 now', normalizeState({}, T0).since, T0);
}

// ── 写入心情 ───────────────────────────────────────────────────────────
section('设置心情');
{
  let s = createDefaultMood(T0);
  s = setMood(s, { label: '有点闷', reason: '他说自己很没用', pleasure: -0.5, now: T0 });
  eq('label 写进去了', s.label, '有点闷');
  eq('reason 写进去了', s.reason, '他说自己很没用');
  eq('pad 生效', s.pad.pleasure, -0.5);
  eq('since 设为写入时刻', s.since, T0);
  eq('updatedAt 推进', s.updatedAt, T0);

  // 只改 label，不改 pad：pad 必须先衰减到 now
  const later = T0 + 90 * MIN;
  const s2 = setMood(s, { label: '好一点了', now: later });
  ok('只改 label 时 pad 也被衰减了（不衰减就会停在 -0.5）', s2.pad.pleasure > -0.5, String(s2.pad.pleasure));
  eq('label 变了 → since 重置', s2.since, later);

  // 只改 reason，label 不变：since 不能动
  const s3 = setMood(s2, { reason: '他又提了一句', now: later + 10 * MIN });
  eq('label 没变 → since 保持', s3.since, later);
  eq('reason 更新了', s3.reason, '他又提了一句');

  // 连写三条同一个心情，起点应该还是第一条
  let s4 = setMood(createDefaultMood(T0), { label: '还是有点闷', now: T0 });
  s4 = setMood(s4, { label: '还是有点闷', now: T0 + 5 * MIN });
  s4 = setMood(s4, { label: '还是有点闷', now: T0 + 9 * MIN });
  eq('重复同一个心情不重置起点', s4.since, T0);

  // 三个维度都能单独设
  const s5 = setMood(createDefaultMood(T0), { pleasure: 0.7, arousal: 0.2, dominance: -0.1, now: T0 });
  eq('pleasure 独立设置', s5.pad.pleasure, 0.7);
  eq('arousal 独立设置', s5.pad.arousal, 0.2);
  eq('dominance 独立设置', s5.pad.dominance, -0.1);
}

// ── 暗流 ───────────────────────────────────────────────────────────────
section('暗流：压着没说的事');
{
  let s = createDefaultMood(T0);
  s = ventUndercurrent(s, { text: '其实刚才那句话有点扎人', weight: 0.6, now: T0 });
  s = ventUndercurrent(s, { text: '想问他是不是不高兴了', weight: 0.3, now: T0 + MIN });
  eq('压了 2 件', s.undercurrent.length, 2);
  near('总重 0.9', undercurrentLoad(s), 0.9);
  ok('每件都有 id', s.undercurrent.every((x) => x.id && x.id.startsWith('u')));

  throws('空文本要报错', () => ventUndercurrent(s, { text: '   ' }));

  const first = s.undercurrent[0];
  const resolved = resolveUndercurrent(s, first.id, T0 + 5 * MIN);
  eq('拿出 1 件后剩 1 件', resolved.state.undercurrent.length, 1);
  eq('拿出的是那一件', resolved.item.text, '其实刚才那句话有点扎人');
  const missing = resolveUndercurrent(resolved.state, 'u00000');
  eq('找不到时 item 为 null', missing.item, null);

  let full = createDefaultMood(T0);
  for (let i = 0; i < MAX_UNDERCURRENT; i += 1) {
    full = ventUndercurrent(full, { text: `第 ${i} 件`, now: T0 });
  }
  eq('压到上限', full.undercurrent.length, MAX_UNDERCURRENT);
  throws('超上限要报错', () => ventUndercurrent(full, { text: '再来一件' }));

  const long = ventUndercurrent(createDefaultMood(T0), { text: 'x'.repeat(500) });
  eq('文本截断', long.undercurrent[0].text.length, MAX_VENT_CHARS);
}

// ── 好感度 ─────────────────────────────────────────────────────────────
section('好感度：1~10 的秤');
{
  let s = createDefaultMood(T0);
  s = setAffinity(s, { level: 5, note: '会主动找我了，但还没到那种程度', now: T0 });
  eq('设成 5', s.affinity.level, 5);
  eq('note 存下来了', s.affinity.note, '会主动找我了，但还没到那种程度');

  const onlyNote = setAffinity(s, { note: '最近话变多了', now: T0 + MIN });
  eq('只改 note 不动数字', onlyNote.affinity.level, 5);

  const onlyLevel = setAffinity(s, { level: 7, now: T0 + MIN });
  eq('只改数字不动 note', onlyLevel.affinity.note, s.affinity.note);

  eq('小数取整', setAffinity(s, { level: 6.7 }).affinity.level, 7);
  throws('0 越界', () => setAffinity(s, { level: 0 }));
  throws('11 越界', () => setAffinity(s, { level: 11 }));
  throws('非数字报错', () => setAffinity(s, { level: 'abc' }));
  eq('上限 10 可以', setAffinity(s, { level: 10 }).affinity.level, 10);
  eq('下限 1 可以', setAffinity(s, { level: 1 }).affinity.level, 1);
}

// ── 底色（她自己调，系统不自动漂移）──────────────────────────────────
section('底色：显式修改，有步进上限');
{
  const s = normalizeState({
    pad: { pleasure: 0.9, arousal: 0, dominance: 0 },
    baseline: { pleasure: 0, arousal: 0, dominance: 0 },
    updatedAt: T0,
    baselineUpdatedAt: T0
  }, T0);

  // 想一步挪到 0.9，只许挪一步
  const r1 = setBaseline(s, { pleasure: 0.9, now: T0 + HOUR });
  ok('动了一步', r1.moved);
  near('一次最多 0.05', r1.baseline.pleasure, BASELINE_STEP_LIMIT);
  ok('不会直接变成 0.9', r1.baseline.pleasure < 0.9);

  // 连调五次到 0.25
  let cur = s;
  for (let i = 0; i < 5; i += 1) cur = setBaseline(cur, { pleasure: 0.9, now: T0 + (i + 1) * HOUR }).state;
  near('调五次到 0.25', cur.baseline.pleasure, 0.25);

  // 反向同样限速
  const down = setBaseline(s, { pleasure: -0.9, now: T0 + HOUR });
  near('反向也限速', down.baseline.pleasure, -BASELINE_STEP_LIMIT);

  // 不传不动
  const none = setBaseline(s, { now: T0 + HOUR });
  eq('不传就不动', none.moved, false);
  eq('不传也不推进时间戳', none.state.baselineUpdatedAt, T0);

  // 非法值当没传
  const junk = setBaseline(s, { pleasure: 'abc', now: T0 + HOUR });
  eq('非法值不算改动', junk.moved, false);

  // 关键：没有任何「时间到了自己动」的路径
  const late = normalizeState(s, T0 + 100 * 24 * HOUR);
  eq('放 100 天，底色不会自己动', late.baseline.pleasure, 0);
}

// ── 读出来给人看 ───────────────────────────────────────────────────────
section('时长说人话');
{
  eq('刚刚', formatDuration(0), '刚刚');
  eq('不到一分钟也是刚刚', formatDuration(59 * 1000), '刚刚');
  eq('分钟', formatDuration(40 * MIN), '40 分钟前开始');
  eq('小时', formatDuration(3 * HOUR), '3 小时前开始');
  eq('天', formatDuration(2 * 24 * HOUR + 5 * HOUR), '2 天前开始');
  eq('负数当零', formatDuration(-1000), '刚刚');
}

section('注入文本');
{
  eq('什么都没发生过 → 一个字都不注入', describeMood(createDefaultMood(T0), T0), '');

  let s = setMood(createDefaultMood(T0), {
    label: '闷闷的', reason: '他说自己很没用', pleasure: -0.4, now: T0 - 40 * MIN
  });
  const text = describeMood(s, T0);
  ok('带【此刻】', text.includes('【此刻】闷闷的 · 他说自己很没用（40 分钟前开始）'), text);
  ok('没有数字（PAD 不外露）', !/\d\.\d/.test(text), text);
  ok('三行封顶', text.split('\n').length <= 3, text);

  const withVent = ventUndercurrent(s, { text: '压着的一件事' });
  ok('压着的事提一句', describeMood(withVent, T0).includes('【压着】1 件事没说'));

  const heavy = ventUndercurrent(
    ventUndercurrent(ventUndercurrent(s, { text: 'a', weight: 1 }), { text: 'b', weight: 1 }),
    { text: 'c', weight: 1 }
  );
  ok('压得沉时换说法', describeMood(heavy, T0).includes('压得有点沉'), describeMood(heavy, T0));

  ok('底色偏了才说', describeBaseline(normalizeState({ baseline: { pleasure: -0.3 } })) === '最近偏沉');
  eq('底色没偏不说', describeBaseline(createDefaultMood(T0)), '');
  eq('底色偏亮', describeBaseline(normalizeState({ baseline: { pleasure: 0.5 } })), '最近偏亮');

  // 只写 reason 没写 label 时，第一行不出现（没心情就没「此刻」）
  const noLabel = setMood(createDefaultMood(T0), { reason: '不知道' });
  ok('没 label 就没【此刻】', !describeMood(noLabel, T0).includes('【此刻】'));
}

section('effectiveMood 只读不写');
{
  const s = setMood(createDefaultMood(T0), { label: '平静', pleasure: 0.2, now: T0 });
  const snapshot = JSON.stringify(s);
  const e1 = effectiveMood(s, T0 + 30 * MIN);
  const e2 = effectiveMood(s, T0 + 30 * MIN);
  eq('同一时刻两次读结果一致', JSON.stringify(e1), JSON.stringify(e2));
  eq('读不修改原状态', JSON.stringify(s), snapshot);
  ok('durationMs 是 30 分钟', Math.abs(e1.durationMs - 30 * MIN) <= 1000);
  // pleasure 0.2、底色 0.1 → 偏离 0.1 走轻档（20 分钟半衰期）
  // 30 分钟后 = 0.1 + 0.1 * 0.5^1.5 = 0.1354，比写下去的 0.2 低，但还没归位
  near('pad 是衰减后的值', e1.pad.pleasure, 0.1 + 0.1 * Math.pow(0.5, 1.5));
}

// ── 读 / 写盘 ──────────────────────────────────────────────────────────
section('读写情绪文件');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-test-'));
  const file = path.join(dir, '情绪.json');

  const missing = readMood(file, T0);
  eq('文件不存在 ⇒ 默认状态', missing.label, '');
  eq('不抛错', missing.version, 1);

  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  throws('坏 JSON 必须抛错（绝不当默认状态覆盖）', () => readMood(file, T0));

  fs.unlinkSync(file);
  const saved = setMood(createDefaultMood(T0), {
    label: '有点困', reason: '聊到很晚', pleasure: -0.1, arousal: -0.4, now: T0
  });
  const withVent = ventUndercurrent(saved, { text: '想问他明天还来不来', weight: 0.5, now: T0 });
  const bytes = writeMood(file, withVent);
  ok('写盘返回字节数', bytes > 0);
  ok('文件真的存在', fs.existsSync(file));

  const back = readMood(file, T0);
  eq('label 回来了', back.label, '有点困');
  eq('reason 回来了', back.reason, '聊到很晚');
  eq('pad 回来了', back.pad.arousal, -0.4);
  eq('暗流回来了', back.undercurrent.length, 1);
  eq('暗流文本回来了', back.undercurrent[0].text, '想问他明天还来不来');

  // 往返幂等：读出来再写进去，字节应该一样
  const bytes2 = writeMood(file, back);
  eq('读写往返字节稳定', bytes2, bytes);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('落盘是 2 空格缩进的可读 json', fs.readFileSync(file, 'utf8').includes('\n  "version"'));

  // 空目录自动创建
  const nested = path.join(dir, 'a', 'b', '情绪.json');
  notThrows('父目录不存在也能写', () => writeMood(nested, back));

  fs.rmSync(dir, { recursive: true, force: true });
}

section('自检视图');
{
  const s = setAffinity(
    ventUndercurrent(setMood(createDefaultMood(T0), { label: '还行', now: T0 }), { text: 'x', weight: 0.4 }),
    { level: 6, note: '熟了' }
  );
  const stats = moodStats(s, T0 + 10 * MIN);
  eq('label', stats.label, '还行');
  eq('暗流条数', stats.undercurrentCount, 1);
  eq('好感度', stats.affinityLevel, 6);
  ok('有 note', stats.hasNote);
  ok('pad 是对象', stats.pad && typeof stats.pad.pleasure === 'number');
}

section('PAD 键集合稳定');
{
  eq('三个维度', PAD_KEYS.length, 3);
  ok('含 pleasure', PAD_KEYS.includes('pleasure'));
  ok('含 arousal', PAD_KEYS.includes('arousal'));
  ok('含 dominance', PAD_KEYS.includes('dominance'));
}

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log(`\n${pass} 通过，${fail} 失败`);
if (fail > 0) process.exitCode = 1;
