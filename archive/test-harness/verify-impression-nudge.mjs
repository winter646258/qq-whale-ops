// 隔离验证：唤醒提示里的【记印象】/【印象维护】是否渲染
import fs from 'node:fs';

const BASE = '/tmp/in2';
await import(`${BASE}/src/bridge.js`).catch(() => {});
const T = globalThis.__bridgeTest;
if (!T) { console.log('✖ 测试钩子不可用'); process.exit(1); }

// 用不存在的 key 造一个"印象=0 且 最近消息多"的会话来验证触发
const KEY = 'private:9999999999';
const st = T.getSocialV2State(KEY);

// 造 30 条最近消息（超过 nudgeMinRecentMessages=20）
st.recentMessages = Array.from({ length: 30 }, (_, i) => ({
  seq: i + 1, sender: '测试', text: 'x', at: Date.now() - i * 1000, isSelf: false,
}));
st.memberImpressions = {};
st.lastImpressionNudgeAt = 0;

const p1 = T.buildWakePromptV2(KEY, 'test');
const hit1 = p1.includes('【记印象】');
const hasTool = p1.includes('qq_memory_append') && p1.includes('memberImpression');

// ② 已有印象但过时 ⇒ 应出现【印象维护】
st.memberImpressions = { '测试甲': { traits: ['话多'], interactionCount: 5, lastSeenAt: Date.now() } };
st.lastImpressionRefreshAt = Date.now() - 30 * 86400 * 1000;
st.lastImpressionNudgeAt = 0;
const p2 = T.buildWakePromptV2(KEY, 'test');
const hit2 = p2.includes('【印象维护】');

// ③ 冷却未到 ⇒ 都不出现
st.memberImpressions = {};
st.lastImpressionNudgeAt = Date.now();
const p3 = T.buildWakePromptV2(KEY, 'test');
const hit3 = (p3.includes('【记印象】') || p3.includes('【印象维护】'));

// ④ 印象为空且消息不足 ⇒ 不出现
st.lastImpressionNudgeAt = 0;
st.recentMessages = st.recentMessages.slice(0, 5);
const p4 = T.buildWakePromptV2(KEY, 'test');
const hit4 = p4.includes('【记印象】');

console.log('=== 验证结果 ===');
console.log(`① 印象=0 + 消息30  -> 出现【记印象】 : ${hit1} ${hit1 ? 'PASS' : 'FAIL'}`);
console.log(`   提示里带 qq_memory_append + memberImpression : ${hasTool} ${hasTool ? 'PASS' : 'FAIL'}`);
console.log(`② 有印象 + 30天未改 -> 出现【印象维护】: ${hit2} ${hit2 ? 'PASS' : 'FAIL'}`);
console.log(`③ 冷却未到          -> 都不出现      : ${!hit3} ${!hit3 ? 'PASS' : 'FAIL'}`);
console.log(`④ 印象=0 + 消息5    -> 不出现       : ${!hit4} ${!hit4 ? 'PASS' : 'FAIL'}`);
if (hit1) {
  const i = p1.indexOf('【记印象】');
  console.log('\n【记印象】原文片段：');
  console.log('  ' + p1.slice(i, i + 240).replace(/\n/g, '\n  '));
}
console.log(`\n提示词长度: ${p1.length} / ${p2.length} / ${p3.length} / ${p4.length}`);
