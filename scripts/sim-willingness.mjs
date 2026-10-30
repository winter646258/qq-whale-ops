// 模拟：真实群聊节奏下，意愿门到底让她多久说一次话。
// 这不是单测，是「参数调得对不对」的体检 —— 单测只能证明逻辑没错，
// 证明不了手感。跑法：node scripts/sim-willingness.mjs [tier]
import {
  consumeWillingness,
  evaluateWillingness,
  resolveWillingness,
  WILLINGNESS_TIERS
} from '../src/willingness.js';

const tier = process.argv[2] || 'normal';
const CFG = { enabled: true, auto: false, tier };

// 一个「中等热闹」的群：平均 25 秒一条消息，偶尔停顿，偶尔爆发。
// 用固定种子保证可复现，不用 Math.random（否则每次跑结论都不一样）。
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const rng = makeRng(20261030);
const HOURS = 6;
const T0 = Date.UTC(2026, 9, 30, 6, 0, 0);

let now = T0;
let state = undefined;
let spokeAt = 0;
let spokes = 0;
const gaps = [];
let messages = 0;
let skipped = 0;
let below = 0;
let rolled = 0;
let silentStreak = 0;
const longestSilence = { ms: 0 };

while (now < T0 + HOURS * 3600 * 1000) {
  // 消息到达间隔：基础 25 秒，20% 概率停 3 分钟（有人在忙）
  const pause = rng() < 0.2 ? 180000 + rng() * 120000 : 25000 + rng() * 40000;
  now += pause;
  messages += 1;

  // 一批里可能连着来几条
  const burst = rng() < 0.25 ? 1 + Math.floor(rng() * 3) : 1;

  const d = evaluateWillingness(state, CFG, {
    now,
    messageCount: burst,
    content: '随便说点什么',
    reason: rng() < 0.06 ? 'atMention' : 'keyword:小鲸鱼',
    rhythm: 'available',
    random: rng
  });
  state = d.state;

  if (d.reason === 'skip') skipped += 1;
  else if (d.reason === 'below-threshold') below += 1;
  else if (d.reason === 'roll') rolled += 1;

  if (d.shouldCall) {
    if (spokeAt) gaps.push((now - spokeAt) / 1000);
    spokeAt = now;
    spokes += 1;
    state = consumeWillingness(state, CFG, now, rng);
  } else if (spokeAt && now - spokeAt > longestSilence.ms) {
    longestSilence.ms = now - spokeAt;
  }
}

const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
const sorted = [...gaps].sort((a, b) => a - b);
const pct = (p) => (sorted.length ? sorted[Math.floor(sorted.length * p)] : 0);
const conf = resolveWillingness(CFG);

console.log(`档位 ${tier}（阈值 ${conf.threshold} / 回复代价 ${conf.replyCost} / 半衰期 ${conf.decayHalfLifeSeconds}s）`);
console.log(`模拟 ${HOURS} 小时，${messages} 条消息（含突发批量）`);
console.log(`她开口 ${spokes} 次  →  平均 ${(avgGap / 60).toFixed(1)} 分钟一次`);
console.log(`间隔分布：最快 ${pct(0.1).toFixed(0)}s / 中位 ${pct(0.5).toFixed(0)}s / 最慢 ${pct(0.9).toFixed(0)}s`);
console.log(`裁定分布：跳过 ${skipped} / 不够分 ${below} / 进入掷骰 ${rolled}`);
console.log(`最长沉默 ${(longestSilence.ms / 60000).toFixed(1)} 分钟`);
console.log('');
console.log('对照：');
console.log(`  每 ${(messages / Math.max(1, spokes)).toFixed(1)} 条消息说一句`);
for (const t of Object.keys(WILLINGNESS_TIERS)) {
  const c = resolveWillingness({ enabled: true, auto: false, tier: t });
  console.log(`  ${t.padEnd(9)} 阈值 ${String(c.threshold).padEnd(5)} 回复代价 ${c.replyCost}`);
}
