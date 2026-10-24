// 阶段20：控制台巡检小族（工具日志 / 反馈 / 我的最近 / 活跃成员）。
//
// 这一族有一共性：都是**只读统计**，原来分散在老 if 链的四段里。
// 鉴权口径分两种，必须分开写，不能一律 rejectAgent：
//   · tool-log / feedback / *-clear：纯控制台接口，走 rejectAgent
//     （兜住「同时握 console-token 的智能体进程」这一层）
//   · my-recent / active-members：AI 工具面，走
//     agentTokenOk -> v2SessionAllowed -> v2ToolEnabled，**不能**套 rejectAgent
//
// 依赖：readToolLog / readFeedbackEntries 是顶层函数（声明早于注入点），直接引用；
// TOOL_LOG_FILE / FEEDBACK_FILE / atomicWriteJson 同样是顶层常量与函数，直接引用。
// getSocialV2State / readThroughSeqV2 声明在注入点之后，所以在 bridge 侧包成箭头。

const rejectAgent = ({ req, sendJson }) => {
  if (req.headers['x-agent-call'] === undefined && String(req.headers['x-agent-token'] ?? '') === '') return false;
  sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
  return true;
};

function rejectV2(moduleCtx, { req, sendJson, key, tool, what }) {
  if (!req.headers['x-agent-token']) return false;
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
  if (!moduleCtx.agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
  if (!moduleCtx.v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
  if (!moduleCtx.v2ToolEnabled(tool)) { sendJson({ ok: false, error: `工具未启用：${what}` }, 403); return true; }
  return false;
}

function toolLog(ctx, { req, url, sendJson }) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  sendJson({ ok: true, entries: ctx.readToolLog(limit) });
}

function toolLogClear(ctx, { req, sendJson }) {
  try { ctx.fs.writeFileSync(ctx.toolLogFile, '', 'utf8'); } catch {}
  ctx.log('控制台：工具调用日志已清空');
  sendJson({ ok: true });
}

function feedbackList(ctx, { sendJson }) {
  sendJson({ ok: true, entries: ctx.readFeedbackEntries() });
}

function feedbackClear(ctx, { sendJson }) {
  ctx.atomicWriteJson(ctx.feedbackFile, []);
  ctx.log('控制台：清空 AI 反馈');
  sendJson({ ok: true });
}

function myRecent(ctx, { req, url, sendJson }) {
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectV2(ctx, { req, sendJson, key, tool: 'getMyRecent', what: 'qq_get_my_recent_messages' })) return;
  const st = ctx.getSocialV2State(key);
  const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
  sendJson({ ok: true, key, messages: mine, readThroughSeq: ctx.readThroughSeqV2(st) });
}

function activeMembers(ctx, { req, url, sendJson }) {
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectV2(ctx, { req, sendJson, key, tool: 'getActiveMembers', what: 'qq_get_active_members' })) return;
  const st = ctx.getSocialV2State(key);
  const map = new Map();
  for (const m of st.recentMessages) {
    if (!m || m.isSelf) continue;
    const uid = m.userId ? String(m.userId) : '';
    const mapKey = uid || String(m.sender || '未知');
    const cur = map.get(mapKey) || { sender: m.sender || mapKey, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
    if (!cur.userId && uid) cur.userId = uid;
    cur.count += 1;
    if (m.time > cur.lastTime) cur.lastTime = m.time;
    if (m.isOwner) cur.isOwner = true;
    map.set(mapKey, cur);
  }
  const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
  sendJson({ ok: true, key, members });
}

// 统一包一层：context 进、handler 出，catch 里透传 statusCode（见 docs/模块契约.md 第 4 节）
const wrap = (fn) => async function handler(payload) {
  try {
    await fn(this.ctx, payload);
  } catch (error) {
    payload.sendJson({ ok: false, error: `模块处理失败：${error?.message || error}` }, Number(error?.statusCode) || 500);
  }
};

export default {
  name: 'inspect',
  title: '控制台巡检：工具日志 / AI 反馈 / 我的最近 / 活跃成员',
  inject: ['cfg', 'log', 'fs', 'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
    'readToolLog', 'readFeedbackEntries', 'toolLogFile', 'feedbackFile', 'atomicWriteJson',
    'getSocialV2State', 'readThroughSeqV2'],
  routes: [
    { method: 'GET', path: '/api/socialV2/tool-log', kind: 'exact', handler: wrap(toolLog) },
    { method: 'POST', path: '/api/socialV2/tool-log/clear', kind: 'exact', handler: wrap((ctx, p) => { if (rejectAgent(p)) return; return toolLogClear(ctx, p); }) },
    { method: 'GET', path: '/api/socialV2/feedback', kind: 'exact', handler: wrap(feedbackList) },
    { method: 'POST', path: '/api/socialV2/feedback-clear', kind: 'exact', handler: wrap((ctx, p) => { if (rejectAgent(p)) return; return feedbackClear(ctx, p); }) },
    { method: 'GET', path: '/api/socialV2/my-recent', kind: 'exact', handler: wrap(myRecent) },
    { method: 'GET', path: '/api/socialV2/active-members', kind: 'exact', handler: wrap(activeMembers) },
  ],
};