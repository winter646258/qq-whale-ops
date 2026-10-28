// 离线断言：情绪「此刻」会自己凉透（src/mood-store.js 的 describeMood / effectiveMood）。
//
// 病灶（2026-10-28 体检）：decayMood 只衰减 PAD 三维，label/reason 原样进注入，
// 于是她连续几天读到「【此刻】有点意外 · 他居然为了修我的工具把午觉舍了（4 天前开始）」。
// 这里钉死：情绪归位之后，标签必须跟着消失。
import assert from 'node:assert/strict';
import {
  DEFAULT_BASELINE, createDefaultMood, describeMood, effectiveMood, moodIntensity, normalizeState
} from '../src/mood-store.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const NOW = 1792900000000;

function moodWith(patch = {}) {
  return normalizeState({
    pad: { ...DEFAULT_BASELINE },
    baseline: { ...DEFAULT_BASELINE },
    label: '有点意外',
    reason: '他居然为了修我的工具把午觉舍了',
    since: NOW - 10 * 60 * 1000,
    updatedAt: NOW,
    ...patch
  }, NOW);
}

console.log('moodIntensity');
ok('刚写在偏离上 → 强度就是偏离量', () => {
  const s = moodWith({ pad: { pleasure: 0.9, arousal: 0, dominance: 0.1 } });
  const i = moodIntensity(s, NOW);
  assert.ok(Math.abs(i - 0.8) < 0.01, `intensity=${i}`);
});
ok('PAD 已经回到底色 → 强度 0', () => {
  assert.equal(moodIntensity(moodWith(), NOW), 0);
});

console.log('describeMood：该出的时候出');
ok('偏离够大 → 有【此刻】这一行', () => {
  const text = describeMood(moodWith({ pad: { pleasure: 0.9, arousal: 0.2, dominance: 0.1 } }), NOW);
  assert.match(text, /【此刻】有点意外 · 他居然为了修我的工具把午觉舍了/);
});
ok('没有数字（只给模糊几行）', () => {
  const text = describeMood(moodWith({ pad: { pleasure: 0.9, arousal: 0, dominance: 0.1 } }), NOW);
  assert.doesNotMatch(text, /\d\.\d{3}/);
});

console.log('describeMood：该淡的时候淡（本次修复的核心）');
ok('PAD 归位之后，标签整行不出现', () => {
  const text = describeMood(moodWith(), NOW);
  assert.equal(text.includes('【此刻】'), false, text);
  assert.equal(text.includes('有点意外'), false, text);
});
ok('隔了四天、PAD 早已衰减归位 → 不再念「4 天前开始」', () => {
  // updatedAt 是四天前，pad 当时偏离 0.9 —— 衰减到现在早已归零
  const old = moodWith({
    pad: { pleasure: 0.9, arousal: 0.5, dominance: -0.4 },
    since: NOW - 4 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 4 * 24 * 60 * 60 * 1000
  });
  const text = describeMood(old, NOW);
  assert.equal(text.includes('【此刻】'), false, text);
  assert.equal(text.includes('天前开始'), false, text);
});
ok('PAD 还很高但标签挂了超过上限 → 也淡掉', () => {
  // updatedAt=now 让衰减不发生，deviation 仍是 0.8；但 since 是 30 小时前
  const stale = moodWith({
    pad: { pleasure: 0.9, arousal: 0, dominance: 0.1 },
    since: NOW - 30 * 60 * 60 * 1000
  });
  const text = describeMood(stale, NOW);
  assert.equal(text.includes('【此刻】'), false, text);
});
ok('底色和暗流的行不受影响', () => {
  const s = moodWith({
    baseline: { pleasure: -0.4, arousal: 0, dominance: 0.1 },
    undercurrent: [{ text: '话没说完', weight: 0.9 }]
  });
  const text = describeMood(s, NOW);
  assert.match(text, /【底色】最近偏沉/);
  assert.match(text, /【压着】1 件事没说/);
});

console.log('可调旋钮');
ok('labelMinIntensity 调高 → 轻微偏离也不出标签', () => {
  // 偏离 0.3（0.4 − 底色 0.1）：默认 0.12 的闸放行，把闸抬到 0.5 就挡住
  const s = moodWith({ pad: { pleasure: 0.4, arousal: 0, dominance: 0.1 } });
  assert.match(describeMood(s, NOW), /【此刻】/);
  assert.equal(describeMood(s, NOW, { labelMinIntensity: 0.5 }).includes('【此刻】'), false);
});
ok('labelMaxMs 调小 → 提前淡掉', () => {
  const s = moodWith({ pad: { pleasure: 0.9, arousal: 0, dominance: 0.1 }, since: NOW - 2 * 60 * 60 * 1000 });
  assert.match(describeMood(s, NOW), /【此刻】/);
  assert.equal(describeMood(s, NOW, { labelMaxMs: 60 * 60 * 1000 }).includes('【此刻】'), false);
});

console.log('effectiveMood 暴露强度与淡出状态');
ok('intensity / faded 字段', () => {
  const fresh = effectiveMood(moodWith({ pad: { pleasure: 0.9, arousal: 0, dominance: 0.1 } }), NOW);
  assert.equal(fresh.faded, false);
  assert.ok(fresh.intensity > 0.5);
  const gone = effectiveMood(moodWith(), NOW);
  assert.equal(gone.faded, true);
  assert.equal(gone.intensity, 0);
});
ok('默认状态（从没写过心情）不注入任何东西', () => {
  assert.equal(describeMood(createDefaultMood(NOW), NOW), '');
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
