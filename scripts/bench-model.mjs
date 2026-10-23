// 渠道测速：建临时会话 → selectModel → 发一句固定提示 → 记录总耗时与首字延迟。
//
// 和 probe-model.mjs 的区别：那个只回答「通不通」，这个回答「多快」。
// 输出一行 TSV：provider \t model \t effort \t ok \t totalMs \t ttftMs \t textLen
//
// 用法: node bench-model.mjs <provider> <model> <effort> [超时秒] [提示词]
// 退出码 0 = 拿到了非空回复；1 = 失败/超时。

import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector } from '/opt/qq-bridge/src/dsh-client.js';

const [provider, model, effort, timeoutSec = '90', promptText = '回复：ok'] = process.argv.slice(2);
if (!provider || !model) {
  console.error('usage: node bench-model.mjs <provider> <model> <effort> [timeoutSec] [prompt]');
  process.exit(2);
}

const base = 'http://127.0.0.1:3081';
const dir = '/tmp/model-bench';
let sessionId = null;
let ttftMs = null;
let startedAt = 0;
let done = null;

function emit(ok, totalMs, text) {
  const len = String(text ?? '').trim().length;
  console.log([provider, model, effort, ok ? 'OK' : 'FAIL', totalMs, ttftMs ?? -1, len].join('\t'));
}

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

  const pump = (async () => {
    for await (const env of api.events.mux({}, ac.signal)) {
      const f = env?.payload ?? env;
      if (f?.type !== 'session/event' || f.sessionId !== sessionId) continue;
      // 第一帧「已经和她有关」的事件就算首字到达：思考流也算，因为它证明上游已开始吐字。
      if (ttftMs === null && startedAt > 0) ttftMs = Date.now() - startedAt;
      const ended = collector.push(f.event);
      if (ended) { done = ended; ac.abort(); break; }
    }
  })().catch(() => {});

  await new Promise((r) => setTimeout(r, 300));
  startedAt = Date.now();
  const accepted = await api.sessions.prompt({
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: promptText }]
  });
  if (!accepted.result.ok) {
    console.log([provider, model, effort, 'FAIL', -1, -1, `prompt-rejected:${accepted.result.error?.code ?? '?'}`].join('\t'));
    process.exit(1);
  }

  await new Promise((resolve) => {
    const iv = setInterval(() => { if (done) { clearInterval(iv); resolve(); } }, 100);
    ac.signal.addEventListener('abort', () => { clearInterval(iv); resolve(); });
  });
  clearTimeout(timer);
  await pump;

  const text = String(done?.text ?? '').trim();
  const kind = done?.reason?.kind ?? 'no-turn-end';
  const ok = Boolean(done) && kind === 'completed' && text.length > 0
  if (!ok) console.error('DIAG ' + JSON.stringify(done?.reason ?? { none: true }).slice(0, 400));
  emit(ok, Date.now() - startedAt, text);
  try { await api.workspace.archiveSession({ sessionId }); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log([provider, model, effort, 'FAIL', Date.now() - (startedAt || Date.now()), ttftMs ?? -1, `error:${e?.message ?? e}`].join('\t'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
