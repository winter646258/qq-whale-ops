#!/usr/bin/env node
/**
 * 给 /api/socialV2/image-approval 补上智能体调用的鉴权。
 *
 * 背景：这个端点是「控制台/管理端用」（代码注释原话），但智能体进程同时持有
 * x-console-token 与 x-agent-token，控制台令牌闸门挡不住它。实测：拿 group:906710082
 * 的 agent token（x-agent-call: 1）请求 ?action=list 得到 HTTP 200 与全局审批统计
 * （pending/approved/rejected/expired、ttlMs、maxPending）——跨会话越权读取。
 *
 * 修法：带 x-agent-token 的请求一律 403「该接口仅控制台可用」，与本文件已有的
 * adminOnlyV2Paths / stickers 两个先例保持同一种写法，不新造机制。
 */
import fs from 'node:fs';

const SRC = '/opt/qq-bridge/src/bridge.js';
const MARKER = '// MARKER: image-approval-console-only';

let s = fs.readFileSync(SRC, 'utf8');

if (s.includes(MARKER)) {
  console.log('已打过补丁（找到 MARKER），跳过');
  process.exit(0);
}

const anchor = [
  '        if ((req.method === \'GET\' || req.method === \'POST\') && url.pathname === \'/api/socialV2/image-approval\') {',
  '          try {',
].join('\n');

const count = s.split(anchor).length - 1;
if (count !== 1) {
  console.error(`锚点匹配 ${count} 次，期望 1 次，中止`);
  process.exit(1);
}

const inject = [
  '        if ((req.method === \'GET\' || req.method === \'POST\') && url.pathname === \'/api/socialV2/image-approval\') {',
  `          ${MARKER}`,
  '          // 审批查询/人工处置是管理端动作：智能体侧走 QQ 里的「通过 / 拒绝」由主人确认，',
  '          // 不该能读全局统计，更不该能自己批一张图（approve 会真的出图并发送）。',
  '          // 智能体进程同时持有 x-console-token，上面的控制台令牌闸门挡不住它，这里必须单独拒绝。',
  '          if (req.headers[\'x-agent-call\'] !== undefined || String(req.headers[\'x-agent-token\'] ?? \'\') !== \'\') {',
  '            sendJson({ ok: false, error: \'该接口仅控制台可用\' }, 403);',
  '            return;',
  '          }',
  '          try {',
].join('\n');

s = s.replace(anchor, inject);
fs.writeFileSync(SRC, s, 'utf8');
console.log('已写入补丁');
