// 参数扫：找一组让 normal 落在「十人群里每 12~15 条说一句」的参数。
import { consumeWillingness, evaluateWillingness } from '../src/willingness.js';

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function run(cfg) {
  const rng = makeRng(20261030);
  const T0 = Date.UTC(2026, 9, 30, 6, 0, 0);
  let now = T0, state, spokeAt = 0, spokes = 0, messages = 0;
  const gaps = [];
  while (now < T0 + 6 * 3600 * 1000) {
    now += rng() < 0.2 ? 180000 + rng() * 120000 : 25000 + rng() * 40000;
    messages += 1;
    const burst = rng() < 0.25 ? 1 + Math.floor(rng() * 3) : 1;
    const d = evaluateWillingness(state, cfg, {
      now, messageCount: burst, content: '随便说点什么',
      reason: rng() < 0.06 ? 'atMention' : 'keyword:小鲸鱼',
      rhythm: 'available', random: rng
    });
    state = d.state;
    if (d.shouldCall) {
      if (spokeAt) gaps.push((now - spokeAt) / 1000);
      spokeAt = now; spokes += 1;
      state = consumeWillingness(state, cfg, now, rng);
    }
  }
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  return { spokes, messages, perMsg: messages / Math.max(1, spokes), avgMin: avg / 60 };
}

const grid = [];
for (const maxScore of [2, 3, 4]) {
  for (const threshold of [0.9, 1.2, 1.6, 2.0, 2.4, 2.8]) {
    if (threshold >= maxScore) continue;
    for (const baseGain of [0.18, 0.22, 0.25]) {
      grid.push({ maxScore, threshold, baseGain, replyCost: 0.8, probabilityAmplifier: 1.4, decayHalfLifeSeconds: 240, enabled: true, auto: false });
    }
  }
}

const rows = grid.map((g) => ({ ...g, ...run({ ...g, tier: 'normal' }) }));
rows.sort((a, b) => a.perMsg - b.perMsg);

console.log('目标区间：每 12~15 条消息说一句\n');
console.log('maxScore threshold gain  →  6h开口  每N条一句  平均间隔');
console.log('─'.repeat(66));
for (const r of rows) {
  const mark = r.perMsg >= 12 && r.perMsg <= 15 ? '  ★' : (r.perMsg >= 9 && r.perMsg <= 20 ? '  ·' : '');
  console.log(
    `${String(r.maxScore).padEnd(8)} ${String(r.threshold).padEnd(9)} ${String(r.baseGain).padEnd(5)} →  ${String(r.spokes).padStart(3)} 次   ${r.perMsg.toFixed(1).padStart(5)} 条   ${r.avgMin.toFixed(1).padStart(5)} 分${mark}`
  );
}
