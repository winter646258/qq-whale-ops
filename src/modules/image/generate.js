// ── 生图：/api/socialV2/image + /api/socialV2/image-approval ──────────
//
// 这一族的三条路由（self-image 在另一个文件）原先挂在 main() 的 if 链里。
// 权限判定全在服务端：prompt 里提不提这个能力只是第一道，真正的闸门是
// imageAllowedNow(key)，它按「主人刚才有没有跟你说话」决定这一轮能不能画。
//
// 两条路由的性格完全不同，别混：
//   · /api/socialV2/image —— 智能体面。要 key + agent token + 会话/模式 + 工具开关；
//     额度不够且场景够格（好友私聊要图）时**不报错**，转成一条待审申请发给主人。
//   · /api/socialV2/image-approval —— 管理端面，只给控制台。
//     approve 会真的出图并发出去，所以这里是**纯操作者通道**，智能体一律 403。
//     智能体进程同时持有 x-console-token，控制台令牌闸门挡不住它，必须单独拒。
//
// 生图很贵（一约 $0.01）且慢（36~50 秒），所以有两道保护：
//   ① IMAGE_THROTTLE_MS 内同一会话不重复画（429 + retryAfterMs）；
//   ② 画完直接发群/发私聊 —— 工具只把 url 当文本回给模型，她自己看不到图，
//      不发等于白画。发送失败只记日志，生图结果照常返回。

function isAgentCall(req) {
  return req.headers['x-agent-call'] !== undefined
    || String(req.headers['x-agent-token'] ?? '') !== '';
}

// ── 智能体面：生图 ────────────────────────────────────────────────
async function image({ req, url, sendJson, readBody }) {
  const ctx = this.ctx;
  const { cfg, log, path, imageHelpers: h } = ctx;
  // 免审批放行标记：整段 try/catch 都要看得到（成功与失败都要报备）。
  let reportOnly = false;
  // MARKER: image-catch-scope（2026-10-27）
  // key / body 也必须在 try 之外声明。原先它们是 try 内的 const，而 catch 里要用
  // 它们调 reportImageUsage —— 一旦 try 里出错，catch 自己先抛 ReferenceError：
  //   ① 真正的错误被吃掉（日志只剩 "key is not defined"）；
  //   ② sendJson 那行永远执行不到，客户端拿不到响应，回合白白耗到超时被掐。
  // 实测代价：private:2627346728 一个回合烧了 608s / 9 步后中止。
  let key = '';
  let body = {};
  try {
    const q = url.searchParams;
    body = req.method === 'POST' ? ((await readBody()) ?? {}) : {};
    key = String(body.key ?? q.get('key') ?? '').trim();
    const action = String(body.action ?? q.get('action') ?? 'generate').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (req.headers['x-agent-token'] && !h.agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403); return;
    }
    if (req.headers['x-agent-token'] && !ctx.v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return;
    }
    if (req.headers['x-agent-token'] && !ctx.v2ToolEnabled('image')) {
      sendJson({ ok: false, error: '工具未启用：qq_generate_image' }, 403); return;
    }
    if (cfg.socialV2?.image?.enabled === false) {
      sendJson({ ok: false, error: 'qq_generate_image 已在配置里关闭' }, 403); return;
    }

    let permit = h.imageAllowedNow(key);
    // MARKER: image-report-only
    // 主人 2026-10-25 指令「开启画图模式，无需审批，只需要报备管理员」：
    // 好友私聊要图不再排队等审批，直接放行（只放开这一档，群里非主人仍拒绝），
    // 画完把明细报备给主人。config.socialV2.image.reportOnly=false 退回旧的人工审批。
    if (!permit.ok && action === 'generate' && h.imageReportOnly?.() && h.imageApprovalEligible(key)) {
      reportOnly = true;
      permit = { ok: true, scene: 'report-only' };
      log(`[imgapprove] 免审批放行（${key}）：${String(body.prompt ?? '').slice(0, 40)}`);
    }
    if (!permit.ok) {
      // 好友私聊要图：不画，转成一条待审申请发给主人。其余场景仍照旧 403。
      if (action === 'generate' && h.imageApprovalEligible(key)) {
        const reqPrompt = String(body.prompt ?? '').trim();
        if (!reqPrompt) { sendJson({ ok: false, error: 'prompt 不能为空' }, 400); return; }
        if (reqPrompt.length > h.maxPromptChars()) {
          sendJson({ ok: false, error: `prompt 太长（上限 ${h.maxPromptChars()} 字）` }, 400);
          return;
        }
        const requested = h.requestImageApproval(key, reqPrompt, String(body.size ?? '').trim());
        if (!requested.ok) { sendJson({ ok: false, error: requested.error }, 409); return; }
        sendJson({
          ok: true,
          key,
          action,
          status: 'pending-approval',
          approvalId: requested.approval.id,
          reused: requested.reused,
          ttlMs: h.ttlMs(),
          note: requested.note
        });
        return;
      }
      sendJson({ ok: false, error: permit.why }, 403); return;
    }

    if (action === 'status') {
      sendJson({
        ok: true, key, action, scene: permit.scene,
        model: cfg.socialV2?.image?.model ?? 'gpt-image-2',
        size: cfg.socialV2?.image?.size ?? '1024x1024'
      });
      return;
    }
    if (action !== 'generate') {
      sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 generate / status）' }, 400);
      return;
    }
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) { sendJson({ ok: false, error: 'prompt 不能为空' }, 400); return; }
    if (prompt.length > 2000) { sendJson({ ok: false, error: 'prompt 太长（上限 2000 字）' }, 400); return; }

    // 防连点：上一张还在画（或者刚画完不到一分钟）就不要再花一次钱。
    const lastStart = Number(h.lastStartAt(key) || 0);
    const sinceLast = Date.now() - lastStart;
    if (lastStart && sinceLast < h.throttleMs()) {
      const waitSec = Math.ceil((h.throttleMs() - sinceLast) / 1000);
      log(`[reserved2] 生图被限流（${key}）：${waitSec} 秒内已画过一次，这次不画`);
      sendJson({
        ok: false,
        error: `上一张还在画（${waitSec} 秒前刚画过一张），别重复调 —— 画完会直接发出来。`,
        throttled: true,
        retryAfterMs: h.throttleMs() - sinceLast
      }, 429);
      return;
    }
    h.markStart(key);
    const genStartedAt = Date.now();
    log(`[reserved2] 生图请求（${permit.scene}，${key}）：${prompt.slice(0, 60)}`);
    const result = await h.generateImageNow({ prompt, size: body.size });
    // 画完就发：工具只把 url/本地路径当文本回给模型，她自己看不到图，主人也收不到。
    // 不发等于白画一张，所以默认发。发送失败只记日志，生图结果照常返回。
    let sent = false;
    try {
      if (result?.path) {
        const [sendKind, sendId] = String(key).split(':');
        if ((sendKind === 'group' || sendKind === 'private') && Number(sendId) > 0) {
          await h.onebotSend(sendKind, Number(sendId), '', null, null, [result.path]);
          sent = true;
          log(`[reserved2] 生图已发送（${key}）：${path.basename(result.path)}`);
        }
      }
    } catch (error) {
      log(`[reserved2] 生图后发送失败（${key}）：${error?.message ?? error}`);
    }
    if (reportOnly && typeof h.reportImageUsage === 'function') {
      void h.reportImageUsage({
        key, scene: permit.scene, prompt, size: body.size,
        ok: true, sent, elapsedMs: Date.now() - genStartedAt
      });
    }
    sendJson({ ok: true, key, action, scene: permit.scene, sent, ...result });
  } catch (error) {
    if (reportOnly && typeof h.reportImageUsage === 'function') {
      void h.reportImageUsage({
        key, scene: 'report-only', prompt: String(body?.prompt ?? ''),
        size: body?.size, ok: false, error: String(error?.message ?? error)
      });
    }
    sendJson({ ok: false, error: '生图失败：' + (error?.message ?? error) }, 500);
  }
}

// ── 管理端面：审批查询与人工处置 ────────────────────────────────────
async function imageApproval({ req, url, sendJson, readBody }) {
  const { log, imageHelpers: h } = this.ctx;
  // 审批查询/人工处置是管理端动作：智能体侧走 QQ 里的「通过 / 拒绝」由主人确认，
  // 不该能读全局统计，更不该能自己批一张图（approve 会真的出图并发送）。
  if (isAgentCall(req)) {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return;
  }
  try {
    const q = url.searchParams;
    const body = req.method === 'POST' ? ((await readBody()) ?? {}) : {};
    const action = String(body.action ?? q.get('action') ?? 'list').trim();
    const st = h.getImageApprovalState();
    if (action === 'list' || action === 'stats') {
      const stats = h.imageApprovalStatsOf(st);
      sendJson({ ok: true, action, ...stats });
      return;
    }
    if (action === 'approve' || action === 'reject') {
      const id = String(body.id ?? q.get('id') ?? '').trim();
      if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
      const res = action === 'approve'
        ? h.approveImageApproval(st, id)
        : h.rejectImageApproval(st, id);
      if (!res.ok) { sendJson({ ok: false, error: res.reason }, 409); return; }
      h.persistImageApproval(action, `${id} ${res.approval.key}`);
      log(`[imgapprove] 人工 ${action} ${id}（${res.approval.key}）`);
      if (action === 'approve') {
        void h.commitApprovedImageApproval(res.approval).catch(() => {});
      }
      sendJson({ ok: true, action, approval: res.approval });
      return;
    }
    sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 list / approve / reject / stats）' }, 400);
  } catch (error) {
    sendJson({ ok: false, error: '生图审批操作失败：' + (error?.message ?? error) }, 500);
  }
}

export const imageRoutes = [
  { method: 'GET', path: '/api/socialV2/image', kind: 'exact', handler: image },
  { method: 'POST', path: '/api/socialV2/image', kind: 'exact', handler: image },
  { method: 'GET', path: '/api/socialV2/image-approval', kind: 'exact', handler: imageApproval },
  { method: 'POST', path: '/api/socialV2/image-approval', kind: 'exact', handler: imageApproval },
];
