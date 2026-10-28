// 按需研究：纯逻辑用例（真 import）。
import {
  RESEARCH_DEFAULTS,
  describePick,
  pickResearchCandidates,
  quotaFor,
  researchCfg
} from '../src/slang-research.js';

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass += 1; return; }
  fails.push(name);
}
function eq(name, a, b) {
  ok(`${name}（实际 ${JSON.stringify(a)} 期望 ${JSON.stringify(b)}）`, JSON.stringify(a) === JSON.stringify(b));
}

const CAND = 'candidate';
const mk = (id, count, meaning = '', status = CAND) => ({ id, count, meaning, status });

// ---- 配置 ----
eq('默认值', researchCfg({}), { minCount: 5, maxPerDay: 6, batch: 10 });
eq('minCount 生效', researchCfg({ researchMinCount: 9 }).minCount, 9);
eq('minCount:null 回落默认（不是 0）', researchCfg({ researchMinCount: null }).minCount, RESEARCH_DEFAULTS.minCount);
eq('minCount:"abc" 回落默认', researchCfg({ researchMinCount: 'abc' }).minCount, RESEARCH_DEFAULTS.minCount);
eq('maxPerDay 生效', researchCfg({ researchMaxPerDay: 2 }).maxPerDay, 2);
eq('没有参数不炸', researchCfg(undefined).batch, RESEARCH_DEFAULTS.batch);

// ---- 配额 ----
eq('当天没用过', quotaFor(null, '2026-10-28', 6), { day: '2026-10-28', used: 0, left: 6, max: 6 });
eq('当天用了 2 条', quotaFor({ day: '2026-10-28', used: 2 }, '2026-10-28', 6), { day: '2026-10-28', used: 2, left: 4, max: 6 });
eq('换天归零', quotaFor({ day: '2026-10-27', used: 6 }, '2026-10-28', 6), { day: '2026-10-28', used: 0, left: 6, max: 6 });
eq('用超了不为负', quotaFor({ day: '2026-10-28', used: 99 }, '2026-10-28', 6).left, 0);
eq('脏 used 当 0', quotaFor({ day: '2026-10-28', used: 'x' }, '2026-10-28', 6).used, 0);

// ---- 选词 ----
const entries = [
  mk('a', 9, ''),           // 够门槛、没释义 → 应排前
  mk('b', 12, '已经有释义了'), // 够门槛、有释义 → 排后
  mk('c', 2, ''),           // 不够门槛
  mk('d', 5, ''),           // 刚好够 5
  mk('e', 30, '', 'confirmed'), // 已确认，不是候选
  null,
  { id: 'f', count: 'x', meaning: '' } // 脏 count → 0
];

const basic = pickResearchCandidates({ entries, statusCandidate: CAND, minCount: 5, limit: 10, quotaLeft: 100 });
ok('门槛过滤掉 count<5', basic.candidates.every((e) => Number(e.count) >= 5 || e.count === 'x'));
eq('挑出 3 条（a/b/d）', basic.candidates.map((e) => e.id), ['a', 'd', 'b']);
ok('没释义的排前面', String(basic.candidates[0].meaning).trim() === '');
ok('已确认的不进研究', basic.candidates.some((e) => e.id === 'e') === false);
ok('null 安全', basic.reason === 'ok');

const noIds = pickResearchCandidates({ entries: [mk('c', 2)], statusCandidate: CAND, minCount: 5, quotaLeft: 100 });
eq('全都不够门槛', noIds.candidates.length, 0);
eq('原因是 below-threshold', noIds.reason, 'below-threshold');

const explicit = pickResearchCandidates({ entries, statusCandidate: CAND, ids: ['c'], minCount: 5, quotaLeft: 100 });
eq('手点名可以越过门槛', explicit.candidates.map((e) => e.id), ['c']);
ok('标记为 explicit', explicit.explicit === true);

const explicitMissing = pickResearchCandidates({ entries, statusCandidate: CAND, ids: ['zzz'], quotaLeft: 100 });
eq('点名不存在', explicitMissing.reason, 'not-found');

const quotaCap = pickResearchCandidates({ entries, statusCandidate: CAND, minCount: 5, limit: 10, quotaLeft: 2 });
eq('配额只够 2 条', quotaCap.candidates.length, 2);
const quotaZero = pickResearchCandidates({ entries, statusCandidate: CAND, minCount: 5, quotaLeft: 0 });
eq('配额用完', quotaZero.reason, 'quota');
eq('配额用完不挑词', quotaZero.candidates.length, 0);

const limited = pickResearchCandidates({ entries, statusCandidate: CAND, minCount: 1, limit: 1, quotaLeft: 100 });
eq('limit 限流', limited.candidates.length, 1);
const limitZero = pickResearchCandidates({ entries, statusCandidate: CAND, minCount: 1, limit: 0, quotaLeft: 100 });
eq('limit 0 走默认批量', limitZero.candidates.length, Math.min(RESEARCH_DEFAULTS.batch, 4));

const empty = pickResearchCandidates({ entries: [], statusCandidate: CAND });
eq('空库', empty.reason, 'empty');
const garbage = pickResearchCandidates({ entries: 'x', statusCandidate: CAND });
eq('脏 entries 不炸', garbage.reason, 'empty');

// ---- 文案 ----
ok('ok 文案带数量', describePick({ reason: 'ok', candidates: [1, 2], minCount: 5 }).includes('2 条'));
ok('quota 文案', describePick({ reason: 'quota', candidates: [] }).includes('配额'));
ok('below 文案带门槛', describePick({ reason: 'below-threshold', candidates: [], minCount: 7 }).includes('7'));

console.log(`\n${fails.length === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
