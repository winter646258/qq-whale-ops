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

// MARKER: group-members-route
// 群成员列表（v2 读工具 qq_get_group_members 的后端）。
//
// 为什么是 v2 形态：qq-chat-v2 预设第 6 条明确叫模型用 qq_get_group_members 拿 QQ 号去 @ 人，
// 而旧的无令牌版本在 reserved2 下必然 403 —— 预设教模型用一个永远失败的工具，每次白烧一步。
//
// 鉴权口径与其它 v2 读工具一致，但**多一条 closed-agent 分支**：
// 管理员私聊里代理没有会话令牌，此时按 allowed('group', …) 判，而不是 v2SessionAllowed。
// ⚠️ 无令牌时也不能跳过白名单 —— 否则它就变成任意群成员枚举入口。
async function groupMembers(moduleCtx, { req, url, sendJson }) {
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const m = /^group:(\d+)$/.exec(key);
  if (!m) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return; }
  const gid = Number(m[1]);
  const token = req.headers['x-agent-token'];
  if (token && !moduleCtx.agentTokenOk(key, token)) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403);
    return;
  }
  const inRange = moduleCtx.currentMode() === 'closed-agent'
    ? moduleCtx.allowed('group', gid, moduleCtx.cfg)
    : moduleCtx.v2SessionAllowed(key);
  if (!inRange) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
  if (token && !moduleCtx.v2ToolEnabled('getGroupMembers')) {
    sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403);
    return;
  }
  let raw;
  try {
    const response = await moduleCtx.bot().request('get_group_member_list', { group_id: gid });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(response?.wording || response?.retcode || 'unknown');
    }
    raw = response.data;
  } catch (wsError) {
    // WS 不可用时走 OneBot HTTP —— 群成员是"等特定的人"这类即时需求，不能因为重连窗口就瞎。
    try {
      raw = await moduleCtx.onebotHttpAction('get_group_member_list', { group_id: gid });
    } catch (httpError) {
      sendJson({ ok: false, error: `获取群成员失败：${wsError?.message ?? wsError}；HTTP 兜底也失败：${httpError?.message ?? httpError}` }, 502);
      return;
    }
  }
  const list = Array.isArray(raw) ? raw : (raw?.data ?? []);
  const members = list
    .slice(0, limit)
    .map((x) => ({
      userId: String(x.user_id ?? ''),
      nickname: moduleCtx.truncateText(x.nickname ?? '', 40),
      card: moduleCtx.truncateText(x.card ?? '', 40),
      ...(x.role ? { role: String(x.role) } : {})
    }))
    .filter((x) => x.userId);
  sendJson({ ok: true, key, count: list.length, returned: members.length, truncated: list.length > members.length, members });
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
    'getSocialV2State', 'readThroughSeqV2',
    'bot', 'onebotHttpAction', 'allowed', 'currentMode', 'truncateText'],
  routes: [
    { method: 'GET', path: '/api/socialV2/tool-log', kind: 'exact', handler: wrap(toolLog) },
    { method: 'POST', path: '/api/socialV2/tool-log/clear', kind: 'exact', handler: wrap((ctx, p) => { if (rejectAgent(p)) return; return toolLogClear(ctx, p); }) },
    { method: 'GET', path: '/api/socialV2/feedback', kind: 'exact', handler: wrap(feedbackList) },
    { method: 'POST', path: '/api/socialV2/feedback-clear', kind: 'exact', handler: wrap((ctx, p) => { if (rejectAgent(p)) return; return feedbackClear(ctx, p); }) },
    { method: 'GET', path: '/api/socialV2/my-recent', kind: 'exact', handler: wrap(myRecent) },
    { method: 'GET', path: '/api/socialV2/active-members', kind: 'exact', handler: wrap(activeMembers) },
    { method: 'GET', path: '/api/socialV2/group-members', kind: 'exact', handler: wrap((ctx, payload) => groupMembers(ctx, payload)) },
  ],
};