// 直接起一个 MCP stdio 客户端，问 mcp-snowluma-safe.js：
//   1) tools/list 里有没有 qq_shared_memory（注册期过滤有没有把它漏掉）
//   2) tools/call 真调一次 read（走完整 MCP → HTTP 链路）
//
// 不经过 DSH，所以能独立确认「工具确实注册了、确实能通」。
import { spawn } from 'node:child_process';

const ROOT = process.env.QROOT || '/opt/qq-bridge';
const child = spawn('/usr/bin/node', [`${ROOT}/src/mcp-snowluma-safe.js`], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const stderr = [];
child.stderr.on('data', (d) => stderr.push(d.toString('utf8')));

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'verify', version: '1' }
});
console.log('initialize:', init.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 200));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
console.log(`tools/list 共 ${names.length} 个工具`);
console.log('含 qq_shared_memory:', names.includes('qq_shared_memory'));

const tool = (list.result?.tools ?? []).find((t) => t.name === 'qq_shared_memory');
if (tool) {
  console.log('描述前 90 字:', (tool.description || '').slice(0, 90));
  console.log('参数:', Object.keys(tool.inputSchema?.properties ?? {}).join(', '));
}

// 真调一次：拿主人的会话令牌
import fs from 'node:fs';
const TOK_FILE = `${ROOT}/state/console-token`;
const consoleTok = fs.readFileSync(TOK_FILE, 'utf8').trim();
const social = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8'));
const conv = social.conversations['private:1124721191'];
const agentToken = conv?.agentToken;
console.log('拿到 agent token:', !!agentToken);

if (agentToken) {
  const call = await rpc('tools/call', {
    name: 'qq_shared_memory',
    arguments: { key: 'private:1124721191', token: agentToken, action: 'read' }
  });
  const text = call.result?.content?.[0]?.text ?? '(空)';
  console.log('--- tools/call read 返回 ---');
  console.log(text.slice(0, 500));
  console.log('isError:', call.result?.isError === true);

  // 顺带验一下群会话调用（应成功且不含私聊层）
  const gcall = await rpc('tools/call', {
    name: 'qq_shared_memory',
    arguments: { key: 'group:906710082', token: social.conversations['group:906710082']?.agentToken, action: 'read' }
  });
  const gtext = gcall.result?.content?.[0]?.text ?? '';
  console.log('--- 群 read 是否泄漏私聊层:', gtext.includes('不喜欢被打断'));
  console.log('--- 群 read 是否含本群内容:', gtext.includes('追那部新番'));
}

child.stdin.end();
child.kill();
if (stderr.length) console.log('stderr:', stderr.join('').slice(0, 800));
