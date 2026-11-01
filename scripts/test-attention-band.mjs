import { normalizeAttentionBand, normalizeBusyUntil, attentionSnapshot, attentionOf, ATTENTION_BANDS } from '../src/life-timeline.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);

// ---------- 1) normalizeAttentionBand ----------
eq(normalizeAttentionBand('focused'), 'focused', 'focused 原样放行');
eq(normalizeAttentionBand('FOCUSED'), 'focused', '大小写归一');
eq(normalizeAttentionBand('  occupied  '), 'occupied', '去空白');
eq(normalizeAttentionBand('sleep'), 'asleep', 'sleep 兼容成 asleep');
eq(normalizeAttentionBand('available'), 'available', 'available 放行');
eq(normalizeAttentionBand(''), '', '空串返回空');
eq(normalizeAttentionBand(null), '', 'null 返回空');
eq(normalizeAttentionBand(undefined), '', 'undefined 返回空');
eq(normalizeAttentionBand('busy'), '', '认不出的值返回空（不猜）');
eq(ATTENTION_BANDS.length, 4, '只有四档');
eq(ATTENTION_BANDS.includes('focused'), true, 'focused 在白名单里');

// ---------- 2) normalizeBusyUntil ----------
// 09:00-11:30 这格：fromMin=540 toMin=690
eq(normalizeBusyUntil('10:45', 540, 690), 645, '常规区间内的结束点');
eq(normalizeBusyUntil('09:00', 540, 690), 0, '等于起点 → 丢弃（不能是零长度）');
eq(normalizeBusyUntil('08:00', 540, 690), 0, '早于起点 → 丢弃');
eq(normalizeBusyUntil('12:00', 540, 690), 0, '晚于终点 → 丢弃');
eq(normalizeBusyUntil('11:30', 540, 690), 690, '正好等于终点 → 允许');
eq(normalizeBusyUntil('', 540, 690), 0, '空串 → 0（没有显式结束点）');
eq(normalizeBusyUntil(null, 540, 690), 0, 'null → 0');
eq(normalizeBusyUntil('乱写', 540, 690), 0, '非时间 → 0');

// 跨零点：20:00-00:30 → fromMin=1200 toMin=1470
eq(normalizeBusyUntil('23:30', 1200, 1470), 1410, '跨零点格内正常');
eq(normalizeBusyUntil('00:10', 1200, 1470), 1450, '写 00:10 也算（+1440 后落在区间内）');
eq(normalizeBusyUntil('21:00', 1200, 1470), 1260, '同格夜晚时刻');

// ---------- 3) attentionSnapshot ----------
const mkDay = (slots) => ({ slots });
// 09:00-11:30，interruptible 0.4（旧逻辑会判 occupied）
const day1 = mkDay([{ from: '09:00', to: '11:30', fromMin: 540, toMin: 690, where: '书房', doing: '正经干活', interruptible: 0.4 }]);
const at = (h, m) => new Date(2026, 10, 1, h, m, 0).getTime();

const s1 = attentionSnapshot(day1, at(10, 0));
eq(s1.band, 'occupied', '无标注时按 interruptible 推算 occupied');
eq(s1.source, 'heuristic', '来源标 heuristic');
eq(s1.busyUntil, 0, '没有 busyUntil');

// 显式标注 focused + busyUntil 10:45
const day2 = mkDay([{ from: '09:00', to: '11:30', fromMin: 540, toMin: 690, where: '书房', doing: '正经干活', interruptible: 0.4, attentionBand: 'focused', busyUntil: 645 }]);
const s2a = attentionSnapshot(day2, at(10, 0));
eq(s2a.band, 'focused', 'busyUntil 未到 → focused');
eq(s2a.source, 'band', '来源标 band');
eq(s2a.busyUntil, 645, 'busyUntil 透出');
const s2b = attentionSnapshot(day2, at(10, 50));
eq(s2b.band, 'occupied', 'busyUntil 过了 → 降级 occupied');
eq(s2b.source, 'band-expired', '降级来源标 band-expired');

// 显式标注 available 覆盖低 interruptible
const day3 = mkDay([{ from: '09:00', to: '11:30', fromMin: 540, toMin: 690, where: '书房', doing: '正经干活', interruptible: 0.4, attentionBand: 'available' }]);
eq(attentionSnapshot(day3, at(10, 0)).band, 'available', '显式 available 覆盖 interruptible 推算');

// 睡觉格
const day4 = mkDay([{ from: '05:00', to: '07:30', fromMin: 300, toMin: 450, where: '里间', doing: '睡到自然醒', interruptible: 0.5 }]);
eq(attentionSnapshot(day4, new Date(2026, 10, 1, 6, 0, 0).getTime()).band, 'asleep', '里间+睡 → asleep');

// 空 day 不炸
eq(attentionSnapshot(null, at(10, 0)).band, '', '空 day 返回空 band');
eq(attentionSnapshot(mkDay([]), at(10, 0)).band, '', '空 slots 返回空 band');
// 不在任何格的时间：slotAt 的既有语义是「兜底到最后一格」，不是返回 null。
// 这里只是把这个旧行为钉住，避免我误以为改坏了。
const day5 = mkDay([{ from: '09:00', to: '11:30', fromMin: 540, toMin: 690, where: '书房', doing: 'x', interruptible: 0.5 }]);
eq(attentionSnapshot(day5, at(8, 0)).band, 'available', '格外的时刻按 slotAt 兜底到最后一格');
eq(attentionSnapshot(day5, at(8, 0)).fromMin, 540, '兜底也带回该格的 fromMin');

// ---------- 4) attentionOf 兼容性（旧调用点不能坏）----------
eq(attentionOf(day1, at(10, 0)), 'occupied', 'attentionOf 仍返回字符串');
eq(attentionOf(day2, at(10, 0)), 'focused', 'attentionOf 能透出新档 focused');
eq(attentionOf(day2, at(10, 50)), 'occupied', 'focused 过期后 attentionOf 返回 occupied');
eq(attentionOf(null, at(10, 0)), '', 'attentionOf 空 day 返回空串');
const s5 = attentionSnapshot(day5, at(10, 0));
eq(s5.fromMin, 540, 'snapshot 带 fromMin');
eq(s5.toMin, 690, 'snapshot 带 toMin');

// ---------- 5) 跨零点格的 snapshot 时刻换算 ----------
const day6 = mkDay([{ from: '20:00', to: '00:30', fromMin: 1200, toMin: 1470, where: '里间', doing: '窝着', interruptible: 0.7, attentionBand: 'occupied', busyUntil: 1410 }]);
eq(attentionSnapshot(day6, new Date(2026, 10, 1, 23, 0, 0).getTime()).band, 'occupied', '跨零点格 23:00 命中');
eq(attentionSnapshot(day6, new Date(2026, 10, 1, 23, 0, 0).getTime()).busyUntil, 1410, '跨零点格 busyUntil 透出');
eq(attentionSnapshot(day6, new Date(2026, 10, 2, 0, 10, 0).getTime()).band, 'occupied', '跨零点格 00:10 仍命中');

// ---------- 6) focused 必须在 pacing 里被认（否则标了专注反而更吵）----------
{
  const { rhythmOf } = await import('../src/pacing.js');
  const now = new Date(2026, 10, 3, 10, 0, 0).getTime();
  const old = now - 3600 * 1000; // 一小时没人说话
  const r = (att) => rhythmOf({ lastIncomingAt: old, now, hour: 10, attention: att });
  eq(r('focused').level, 'focused', 'pacing 认 focused 这一档');
  eq(r('focused').multiplier, 0.4, 'focused 倍率 0.4');
  eq(r('focused').source, 'life', 'focused 来源标 life');
  eq(r('occupied').multiplier, 0.7, 'occupied 倍率 0.7（旧值不变）');
  // 回归红线：focused 的倍率必须比 available 更低，否则等于标了专注更爱说话
  ok(r('focused').multiplier < r('available').multiplier, 'focused 比 available 更慢（不能反了）');
  ok(r('focused').multiplier < r('occupied').multiplier, 'focused 比 occupied 更慢');
  // 睡眠最硬：深夜任何 attention 都让位
  const night = new Date(2026, 10, 3, 2, 0, 0).getTime();
  const rn = (att) => rhythmOf({ lastIncomingAt: night - 3600000, now: night, hour: 2, attention: att });
  eq(rn('focused').level, 'asleep', '深夜 02:00 focused 让位给 asleep');
  eq(rn('occupied').level, 'asleep', '深夜 02:00 occupied 让位给 asleep');
  // 23:00 也算夜里
  const h23 = new Date(2026, 10, 3, 23, 0, 0).getTime();
  eq(rhythmOf23('focused'), 'asleep', '23:00 focused 让位给 asleep');
  function rhythmOf23(att) {
    return rhythmOf({ lastIncomingAt: h23 - 3600000, now: h23, hour: 23, attention: att }).level;
  }
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);