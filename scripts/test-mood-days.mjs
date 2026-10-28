// 世界层 A 阶段：mood-days.js 单测（心情编年史 + 一句话趋势）
// 跑法：node scripts/test-mood-days.mjs
import {
  MOOD_DAYS_DEFAULTS,
  moodDaysCfg,
  moodTrendLine,
  pruneMoodDays,
  recordMoodDay
} from '../src/mood-days.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) pass += 1;
  else fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const at = (y, m, day, h = 12) => new Date(y, m - 1, day, h, 0, 0).getTime();

// ---------- 配置
const c = moodDaysCfg({});
ok('默认开启', c.enabled === true);
eq('默认保留天数', c.keepDays, MOOD_DAYS_DEFAULTS.keepDays);
eq('阈值默认', c.shiftGap, MOOD_DAYS_DEFAULTS.shiftGap);
eq('enabled:false', moodDaysCfg({ socialV2: { moodDays: { enabled: false } } }).enabled, false);
eq('null 不当 0', moodDaysCfg({ socialV2: { moodDays: { keepDays: null } } }).keepDays, 30);
eq('下限夹住', moodDaysCfg({ socialV2: { moodDays: { keepDays: 1 } } }).keepDays, 3);
eq('阈值夹住', moodDaysCfg({ socialV2: { moodDays: { shiftGap: 9 } } }).shiftGap, 0.6);

// ---------- 记录
let store = recordMoodDay({ days: {} }, {
  now: at(2026, 10, 28, 15),
  label: '有点窘但挺乐',
  pad: { pleasure: 0.35, arousal: 0.15, dominance: -0.15 },
  samples: 7
});
ok('按天落一格', Boolean(store.days['2026-10-28']));
eq('label 存下', store.days['2026-10-28'].label, '有点窘但挺乐');
eq('pad 存下', store.days['2026-10-28'].pad, { pleasure: 0.35, arousal: 0.15, dominance: -0.15 });
eq('samples 存下', store.days['2026-10-28'].samples, 7);

store = recordMoodDay(store, { now: at(2026, 10, 28, 22), label: '后来放松了', pad: { pleasure: 0.5 }, samples: 9 });
eq('同一天以最后一次为准（label）', store.days['2026-10-28'].label, '后来放松了');
eq('同一天不新增格', Object.keys(store.days).length, 1);
eq('缺的 pad 维度补 0', store.days['2026-10-28'].pad, { pleasure: 0.5, arousal: 0, dominance: 0 });
const clamp = recordMoodDay({ days: {} }, { now: at(2026, 10, 28, 10), label: 'x'.repeat(40), pad: { pleasure: 9 } });
eq('label 截 20 字', clamp.days['2026-10-28'].label.length, 20);
eq('pad 夹到 1', clamp.days['2026-10-28'].pad.pleasure, 1);
eq('脏 pad 回落 0', recordMoodDay({ days: {} }, { now: at(2026, 10, 28, 10), pad: 'hello' }).days['2026-10-28'].pad.pleasure, 0);

// ---------- 清理
const many = { days: {} };
for (const day of ['2026-09-01', '2026-10-20', '2026-10-27', '2026-10-28']) {
  many.days[day] = { label: day, pad: { pleasure: 0, arousal: 0, dominance: 0 }, samples: 1 };
}
many.days['bad'] = { label: 'x' };
const pruned = pruneMoodDays(many, { now: at(2026, 10, 28, 23), keepDays: 10 });
ok('超窗清掉', pruned.days['2026-09-01'] === undefined);
ok('窗口内留下', Boolean(pruned.days['2026-10-20']));
ok('脏键清掉', pruned.days['bad'] === undefined);
eq('清理后条数', Object.keys(pruned.days).length, 3);

// ---------- 趋势
const trendStore = {
  days: {
    '2026-10-25': { label: '有点闷', pad: { pleasure: -0.3, arousal: 0, dominance: 0 } },
    '2026-10-26': { label: '有点闷', pad: { pleasure: -0.2, arousal: 0, dominance: 0 } },
    '2026-10-28': { label: '挺高兴', pad: { pleasure: 0.4, arousal: 0, dominance: 0 } }
  }
};
const up = moodTrendLine(trendStore, { now: at(2026, 10, 28, 20) });
ok('变好有说法', up.includes('舒展'), up);
ok('带上前几天的标签', up.includes('有点闷'), up);
ok('有【最近心情】前缀', up.startsWith('【最近心情】'), up);
ok('一句话不长', up.length <= 60, `len=${up.length}`);

const downStore = {
  days: {
    '2026-10-27': { label: '挺高兴', pad: { pleasure: 0.5, arousal: 0, dominance: 0 } },
    '2026-10-28': { label: '有点来气', pad: { pleasure: -0.2, arousal: 0, dominance: 0 } }
  }
};
ok('变坏有说法', moodTrendLine(downStore, { now: at(2026, 10, 28, 20) }).includes('沉一点'));

const flatStore = {
  days: {
    '2026-10-27': { label: '还行', pad: { pleasure: 0.1, arousal: 0, dominance: 0 } },
    '2026-10-28': { label: '还行', pad: { pleasure: 0.12, arousal: 0, dominance: 0 } }
  }
};
ok('差不多有说法', moodTrendLine(flatStore, { now: at(2026, 10, 28, 20) }).includes('差不多'));

eq('今天没数据就空串', moodTrendLine({ days: { '2026-10-27': { label: 'x', pad: { pleasure: 0 } } } }, { now: at(2026, 10, 28, 20) }), '');
eq('空库空串', moodTrendLine({}, { now: at(2026, 10, 28, 20) }), '');
const onlyToday = moodTrendLine({ days: { '2026-10-28': { label: '平静', pad: { pleasure: 0.1 } } } }, { now: at(2026, 10, 28, 20) });
ok('只有今天时报今天的标签', onlyToday.includes('平静'), onlyToday);
// 阈值可调：差 0.05，默认 0.12 判「差不多」，调到 0.02 就判「舒展」
const tinyStore = {
  days: {
    '2026-10-27': { label: '还行', pad: { pleasure: 0.1, arousal: 0, dominance: 0 } },
    '2026-10-28': { label: '还行', pad: { pleasure: 0.15, arousal: 0, dominance: 0 } }
  }
};
ok('默认阈值下小差距算差不多', moodTrendLine(tinyStore, { now: at(2026, 10, 28, 20) }).includes('差不多'));
ok('阈值调小后能判出舒展', moodTrendLine(tinyStore, { now: at(2026, 10, 28, 20), shiftGap: 0.02 }).includes('舒展'));

if (fails.length) {
  console.error(`✗ test-mood-days: ${pass} 过 / ${fails.length} 败`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✓ test-mood-days: ${pass} 项全过`);
