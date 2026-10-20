// 隔离验证：印象维护提醒是否真的被注入唤醒提示词。
// 用不存在的会话 key（private:9999999999），完全不碰真实会话。
import fs from 'node:fs';

const BASE = '/opt/qq-bridge';
const STATE = `${BASE}/state/social-v2.json`;
const BACKUP = '/tmp/sv2-verify-backup.json';

fs.copyFileSync(STATE, BACKUP);

const mod = await import(`${BASE}/src/bridge.js`);
const T = mod.__bridgeTest;
if (!T) {
  console.log('✖ 测试导出不可用');
  fs.copyFileSync(BACKUP, STATE);
  process.exit(1);
}

const KEY = 'private:9999999999';
const st = T.getSocialV2State(KEY);
st.memberImpressions = {
  '老王': { traits: ['话多', '爱发牢骚'], interactionCount: 12, lastSeenAt: 1700000000000 },
  '赫萝': { traits: ['说话客气'], interactionCount: 3, lastSeenAt: 1700000000000 },
};
st.activeTopics = [{ text: '测试话题', lastMentionAt: Date.now(), participants: [] }];

const DAY = 86400 * 1000;

// ① 旧时间戳 ⇒ 应该出现提醒
st.lastImpressionRefreshAt = Date.now() - 30 * DAY;
const p1 = T.buildWakePromptV2(KEY, 'test');
const hit1 = p1.includes('印象维护');
const hasTool = p1.includes('qq_memory_update');

// ② 新时间戳 ⇒ 应该不出现
st.lastImpressionRefreshAt = Date.now();
const p2 = T.buildWakePromptV2(KEY, 'test');
const hit2 = p2.includes('印象维护');

// ③ 没有印象 ⇒ 不该出现（避免空喊）
st.memberImpressions = {};
st.lastImpressionRefreshAt = Date.now() - 30 * DAY;
const p3 = T.buildWakePromptV2(KEY, 'test');
const hit3 = p3.includes('印象维护');

console.log('=== 验证结果 ===');
console.log('① 旧计时(30天) + 有印象  ⇒ 出现提醒 :', hit1, hit1 ? '✅' : '❌');
console.log('   提醒里带工具名 qq_memory_update  :', hasTool, hasTool ? '✅' : '❌');
console.log('② 新计时(刚刚) + 有印象  ⇒ 不出现   :', !hit2, !hit2 ? '✅' : '❌');
console.log('③ 旧计时 + 无印象        ⇒ 不出现   :', !hit3, !hit3 ? '✅' : '❌');
if (hit1) {
  const i = p1.indexOf('印象维护');
  console.log('\n提醒原文片段：');
  console.log('  ' + p1.slice(i - 2, i + 180).replace(/\n/g, '\n  '));
}
console.log('\n提示词长度：', p1.length, '/', p2.length, '/', p3.length);

// 还原状态文件，并清掉测试会话
fs.copyFileSync(BACKUP, STATE);
console.log('\n状态文件已还原');
process.exit(0);
