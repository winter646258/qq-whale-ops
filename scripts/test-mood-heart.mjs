// 心脏第三层：采样点、底色日结算、手札 TTL 与注入。
import {
  createDefaultMood,
  normalizeState,
  recordMoodSample,
  settleBaseline,
  setMood,
  describeMood,
  UNDERCURRENT_TTL_MS,
  MAX_SAMPLES,
  BASELINE_STEP_LIMIT
} from '../src/mood-store.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const H = 60 * 60 * 1000;
const D = 24 * H;
const T0 = 1800000000000;

// ---- 采样点 ----
const fresh = createDefaultMood(T0);
eq('默认状态有 samples 数组', Array.isArray(fresh.samples), true);
eq('默认没有采样点', fresh.samples.length, 0);

let s = recordMoodSample(fresh, { now: T0 + 1000 });
eq('记一个点', s.samples.length, 1);
ok('点里带时间', s.samples[0].t === T0 + 1000);
ok('点里带三个浮点', ['pleasure', 'arousal', 'dominance'].every((k) => typeof s.samples[0].pad[k] === 'number'));

// 96 上限
let many = fresh;
for (let i = 0; i < 120; i += 1) many = recordMoodSample(many, { now: T0 + i * 60 * 1000 });
eq(`采样点最多 ${MAX_SAMPLES} 个`, many.samples.length, MAX_SAMPLES);

// 26 小时外的点被清掉
const stale = recordMoodSample(fresh, { now: T0 - 30 * H });
eq('三十小时前记的点，在它当时是有效的', stale.samples.length, 1);
eq('超过 26 小时的点读出来会被清掉', normalizeState(stale, T0).samples.length, 0);

// 脏点：pad 缺键丢弃
eq('脏采样点（缺 pad 键）被丢掉', normalizeState({ samples: [{ t: T0, pad: { pleasure: 0.1 } }] }, T0).samples.length, 0);
eq('非数字时间戳被丢掉', normalizeState({ samples: [{ t: 'x', pad: { pleasure: 0, arousal: 0, dominance: 0 } }] }, T0).samples.length, 0);

// ---- 底色日结算 ----
function withSamples(avg, count, { baseAt = T0 - 25 * H, now = T0 } = {}) {
  const samples = Array.from({ length: count }, (_, i) => ({
    t: now - (count - i) * 30 * 60 * 1000,
    pad: { pleasure: avg, arousal: 0, dominance: 0.1 }
  }));
  return normalizeState({ baseline: { pleasure: 0.1, arousal: 0, dominance: 0.1 }, pad: { pleasure: avg, arousal: 0, dominance: 0.1 }, baselineUpdatedAt: baseAt, since: now - H, samples }, now);
}

const soon = settleBaseline(withSamples(0.5, 6, { baseAt: T0 - 2 * H }), { now: T0 });
eq('刚结算过就再来一次：不动', soon.moved, false);
eq('原因写着 too-soon', soon.reason, 'too-soon');

const few = settleBaseline(withSamples(0.5, 3), { now: T0 });
eq('采样点不足 4 个：不动', few.moved, false);
eq('原因写着 too-few-samples', few.reason, 'too-few-samples');

const smallGap = settleBaseline(withSamples(0.15, 8), { now: T0 });
eq('均值只差 0.05（< 0.12）：不动', smallGap.moved, false);

const big = settleBaseline(withSamples(0.5, 8), { now: T0 });
eq('均值差 0.4：动', big.moved, true);
eq('单步最多挪 0.05', big.delta.pleasure, BASELINE_STEP_LIMIT);
eq('底色跟着挪到 0.15', big.state.baseline.pleasure, 0.15);
eq('底线时间戳更新', big.state.baselineUpdatedAt, T0);
eq('arousal 没差：不动', big.delta.arousal, 0);

const down = settleBaseline(withSamples(-0.3, 8), { now: T0 });
eq('往下也能走', down.delta.pleasure, -BASELINE_STEP_LIMIT);
eq('往下走到底色 0.05', down.state.baseline.pleasure, 0.05);

// 慢慢走：连续 5 天都偏亮，底色应该逐步靠近
let cur = withSamples(0.6, 8, { baseAt: T0 - 25 * H });
let day = T0;
for (let i = 0; i < 5; i += 1) {
  const r = settleBaseline(cur, { now: day });
  cur = r.state;
  if (!r.moved) break;
  day += 25 * H;
  cur = normalizeState({ ...cur, samples: Array.from({ length: 8 }, (_, k) => ({ t: day - (8 - k) * 30 * 60 * 1000, pad: { pleasure: 0.6, arousal: 0, dominance: 0.1 } })) }, day);
}
ok('连续偏亮几天后底色真的会往上走', cur.baseline.pleasure > 0.2, `baseline=${cur.baseline.pleasure}`);
ok('但一天最多 0.05，五天最多 0.25', cur.baseline.pleasure <= 0.1 + 0.25 + 1e-9, `baseline=${cur.baseline.pleasure}`);

// ---- 手札 TTL ----
const oldItem = { undercurrent: [{ id: 'v1', text: '四天前的事', weight: 0.3, at: T0 - 4 * D }] };
eq('手札超过 3 天自动凉掉', normalizeState(oldItem, T0).undercurrent.length, 0);
const youngItem = { undercurrent: [{ id: 'v2', text: '昨天的事', weight: 0.3, at: T0 - 1 * D }] };
eq('一天前的手札还在', normalizeState(youngItem, T0).undercurrent.length, 1);
ok('TTL 常量就是 3 天', UNDERCURRENT_TTL_MS === 3 * D);

// ---- 注入 ----
const openMood = normalizeState({
  baseline: { pleasure: 0.1, arousal: 0, dominance: 0.1 },
  pad: { pleasure: 0.1, arousal: 0, dominance: 0.1 },
  since: T0 - H,
  label: '',
  undercurrent: [
    { id: 'a', text: '说好要问他的事一直没问', weight: 0.3, at: T0 - H },
    { id: 'b', text: '生图那笔钱还没算清', weight: 0.3, at: T0 - H },
    { id: 'c', text: '第三条不该露出来', weight: 0.3, at: T0 - H }
  ]
}, T0);
const text = describeMood(openMood, T0);
ok('注入里有【压着】', text.includes('【压着】'));
ok('摊开的是最近两条（第二条）', text.includes('生图那笔钱还没算清'));
ok('摊开的是最近两条（第三条）', text.includes('第三条不该露出来'));
ok('最早那条只算在条数里，不摊开', !text.includes('说好要问他的事一直没问'));
ok('条数写的是 3', text.includes('3 件事'));
ok('超过两条时有省略号', text.includes('…'));
ok('底色偏亮/偏沉没乱写', !text.includes('【底色】') || text.includes('最近偏'));

const emptyMood = normalizeState({ label: '', undercurrent: [] }, T0);
eq('没有手札时整行不出现', describeMood(emptyMood, T0), '');

console.log(`\n心脏第三层：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全绿 ✓');