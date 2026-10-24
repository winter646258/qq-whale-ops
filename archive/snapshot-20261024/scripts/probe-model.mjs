// 真实渠道探测：建临时会话 → selectModel → 发一句最短提示 → 等 turn/end。
// 退出码 0 = 上游真的回了文本；1 = 失败/超时/报错。
// 用法: node probe-model.mjs <provider> <model> <effort> [超时秒]
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector } from '/opt/qq-bridge/src/dsh-client.js';

const [provider, model, effort, timeoutSec = '60'] = process.argv.slice(2);
if (!provider || !model) process.exit(2);

const base = 'http://127.0.0.1:3081';
// 固定目录，不再拼 PID。理由：DSH 会按 workspace 路径给每个会话建一个目录
// （形如 --tmp-channel-probe-<..>--），用 PID 的话每探测一次就多一个，
// 一晚上能攒 67 个。探测是串行的（守护每 300 秒一次），共用同一目录不会打架。
const dir = '/tmp/channel-probe';
let sessionId = null;
try {
  const api = new NodeApiClient(base, undefined, {});
  await api.ensureAuth();
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  sessionId = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'session.create').sessionId;
  api.events.follow(sessionId);
  unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'selectModel');

  const collector = createTurnCollector();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(timeoutSec) * 1000);
  let done = null;
  const pump = (async () => {
    for await (const env of api.events.mux({}, ac.signal)) {
      const f = env?.payload ?? env;
      if (f?.type !== 'session/event' || f.sessionId !== sessionId) continue;
      const ended = collector.push(f.event);
      if (ended) { done = ended; ac.abort(); break; }
    }
  })().catch(() => {});

  await new Promise((r) => setTimeout(r, 300));
  const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '回复：ok' }] });
  if (!accepted.result.ok) { console.log('prompt 被拒:', accepted.result.error.code); }

  await new Promise((resolve) => {
    const iv = setInterval(() => { if (done) { clearInterval(iv); resolve(); } }, 200);
    ac.signal.addEventListener('abort', () => { clearInterval(iv); resolve(); });
  });
  clearTimeout(timer);
  await pump;

  const text = String(done?.text ?? '').trim();
  const kind = done?.reason?.kind ?? 'no-turn-end';
  console.log(`${provider}/${model} (${effort}) reason=${kind} text=>>>${text}<<<`);
  const ok = Boolean(done) && kind === 'completed' && text.length > 0;
  try { await api.workspace.archiveSession({ sessionId }); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(`${provider}/${model} 探测异常: ${e?.message ?? e}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
