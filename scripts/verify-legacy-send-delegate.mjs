#!/usr/bin/env node
/**
 * 验证「主人私聊代发」在**旧版** /api/send/* 端点上也生效了。
 *
 * 背景：10-22 加跨会话代发时只改了 /api/socialV2/* 那四个端点，
 * 漏了更老的 /api/send/group|private|reply —— 而 qq_send_private_message
 * 走的正是它。这个脚本把四条边界都打一遍。
 */

import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3100';
const consoleToken = readFileSync('/opt/qq-bridge/state/console-token', 'utf8').trim();
const OWNER = '1124721191';
const FRIEND = '3098835427';      // 好友，但不在 allow.private
const STRANGER = '123456789';     // 不是好友
const GROUP = '906710082';        // 群

async function post(path, body, token) {
  const headers = { 'content-type': 'application/json', 'x-console-token': consoleToken };
  if (token) headers['x-agent-token'] = token;
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

function show(label, r) {
  const err = r.data?.error;
  const ok = r.data?.ok;
  console.log(`${label.padEnd(42)} status=${r.status} ok=${ok}${err ? ` err=${err}` : ''}`);
  return r;
}

(async () => {
  // 从线上 state 里取主人私聊的令牌
  const fs = await import('node:fs');
  const st = JSON.parse(fs.readFileSync('/opt/qq-bridge/state/social-v2.json', 'utf8'));
  const ownerToken = st.conversations[`private:${OWNER}`]?.agentToken;
  if (!ownerToken) {
    console.log('FAIL: 找不到主人私聊的 agentToken');
    process.exit(1);
  }
  console.log(`主人令牌: ${ownerToken.slice(0, 6)}… (len ${ownerToken.length})\n`);

  console.log('─ 应当放行 ─');
  show('主人令牌 → /api/send/private 好友',
    await post('/api/send/private', { userId: FRIEND, message: '代发测试（legacy 端点）', token: ownerToken }, ownerToken));

  console.log('\n─ 应当拒绝 ─');
  show('主人令牌 → /api/send/private 非好友',
    await post('/api/send/private', { userId: STRANGER, message: 'x', token: ownerToken }, ownerToken));
  show('主人令牌 → /api/send/group',
    await post('/api/send/group', { groupId: GROUP, message: 'x', token: ownerToken }, ownerToken));
  // 「自己的令牌发自己的会话」是正当发送，不算代发 —— 应当放行。
  show('主人自己的令牌 → 主人私聊（正当发送）',
    await post('/api/send/private', { userId: OWNER, message: '正当发送测试', token: ownerToken }, ownerToken));

  // 真正要拦的是：拿**别人**的令牌去发主人私聊。
  const friendSt = st.conversations[`private:${FRIEND}`];
  const friendToken = friendSt?.agentToken;
  if (friendToken) {
    show('好友的令牌 → 主人私聊（冒名代发）',
      await post('/api/send/private', { userId: OWNER, message: 'x', token: friendToken }, friendToken));
    show('好友的令牌 → 另一个好友',
      await post('/api/send/private', { userId: '2050117833', message: 'x', token: friendToken }, friendToken));
  } else {
    console.log('（好友会话还没有令牌，跳过冒名代发用例）');
  }
  show('错误令牌 → /api/send/private 好友',
    await post('/api/send/private', { userId: FRIEND, message: 'x', token: 'wrong-token-xxxxxxxxxxxx' }, 'wrong-token-xxxxxxxxxxxx'));
  show('无令牌 → /api/send/private 好友',
    await post('/api/send/private', { userId: FRIEND, message: 'x' }, null));
})();
