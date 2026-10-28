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
// 生图很贵（一约 $0.01）且慢（36~180 秒），所以有三道保护：
//   ① IMAGE_THROTTLE_MS 内同一会话不重复画（429 + retryAfterMs）；
//   ② 画完直接发群/发私聊 —— 工具只把 url 当文本回给模型，她自己看不到图，
//      不发等于白画。发送失败只记日志，生图结果照常返回。
//   ③ 本地异步（2026-10-28）：请求立刻回执、后台画、画完自己发。回合不再被
//      40~180 秒的等待卡住；同 key 在飞时用 imageJobs 兜住并发（限流窗口只有 60 秒，
//      挡不住一张画 90 秒的第二发）。

// MARKER: image-async-job（2026-10-28）
// 生图改成本地异步。中转排队 36~180 秒，同步等会把整个回合卡住；中间层
// （CF/nginx 60~100 秒）先超时的话，这一回合连图带回合一起白烧（线上见过 504）。
// 现在：① 请求一到就回执，回合继续跑，她能接着聊；② 后台画，画完由后台自己
// 发到群/私聊（发送逻辑与同步版一致）；③ 失败也由后台说一句，别让她以为图在路上。
// 不依赖中转支持异步/回调接口，也不需要给服务器开公网入口。
const imageJobs = new Map(); // key -> { id, startedAt, prompt }

function imageJobId() {
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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

    if (action === 'recent') {
      // 拿回最近画过的图：path 可以直接喂给 qq_qzone 的 images，或者自己再发一次。
      // 放在额度判断之前 —— 额度用光了也不该妨碍她查自己画过什么。
      const limit = Math.min(20, Math.max(1, Number(body.limit) || 5));
      const items = typeof h.recentGeneratedImages === 'function' ? h.recentGeneratedImages(limit) : [];
      sendJson({
        ok: true,
        action,
        items,
        note: items.length
          ? 'path 是长期保留的本地路径，可以直接用作 qq_qzone 的 images，或再发一次。'
          : '还没有画过图。'
      });
      return;
    }
    // MARKER: image-see-action
    // 看图：按最近的带图消息、或指定的 messageRef/url/file 现场识别一张。
    if (action === 'see') {
      if (typeof h.describeMediaByRef !== 'function') {
        sendJson({ ok: false, error: '服务端没有看图能力（版本过旧）' }, 501);
        return;
      }
      try {
        const got = await h.describeMediaByRef(key, {
          messageRef: body.messageRef,
          url: body.url,
          file: body.file,
          refresh: body.refresh === true || body.refresh === 'true'
        });
        if (!got?.ok) { sendJson({ ok: false, error: got?.why || '看不到这张图' }, 200); return; }
        sendJson({ ok: true, action, text: got.text, cached: !!got.cached });
      } catch (error) {
        sendJson({ ok: false, error: '看图失败：' + (error?.message ?? error) }, 500);
      }
      return;
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
    // MARKER: image-selfie
    // 自拍/合照：提示词不让她写，由身份锁 + 场景拼（src/selfie.js），走带参考图的口子，人还是她。
    const isSelfie = action === 'selfie';
    if (action !== 'generate' && !isSelfie) {
      sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 generate / selfie / see / status / recent）' }, 400);
      return;
    }
    let refPath = '';
    let selfieInfo = null;
    let prompt = '';
    if (isSelfie) {
      if (typeof h.selfieQuotaCheck === 'function') {
        const q = h.selfieQuotaCheck();
        if (!q || q.allowed === false) {
          sendJson({ ok: false, error: `今天自拍已经 ${q?.used ?? '?'} 张了（上限 ${q?.max ?? '?'}），明天再拍。`, quota: q }, 429);
          return;
        }
      }
      refPath = typeof h.selfieRefPath === 'function' ? h.selfieRefPath() : '';
      if (!refPath) {
        sendJson({ ok: false, error: '参考图缺失：找不到她自己那张图。先画一张普通图，或把 state/selfie-ref.png 放好。' }, 409);
        return;
      }
      selfieInfo = h.buildSelfiePrompt({
        scene: body.scene,
        withPartner: body.withPartner === true || body.withPartner === 'true',
        style: body.style
      });
      prompt = selfieInfo.prompt;
    } else {
      prompt = String(body.prompt ?? '').trim();
      if (!prompt) { sendJson({ ok: false, error: 'prompt 不能为空' }, 400); return; }
      if (prompt.length > 2000) { sendJson({ ok: false, error: `prompt 太长（上限 2000 字）` }, 400); return; }
    }

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
    // MARKER: image-async-guard
    // 同一个会话已经有在飞的任务就直接挡掉，只靠 IMAGE_THROTTLE_MS 不够：
    // 一张图可能画 90 秒，而限流窗口只有 60 秒，60 秒后再来一发就会并发两张。
    const inflight = imageJobs.get(key);
    if (inflight) {
      const ranSec = Math.max(1, Math.round((Date.now() - inflight.startedAt) / 1000));
      log(`[reserved2] 生图重复调用被拒（${key}，${inflight.id} 已画 ${ranSec} 秒）`);
      sendJson({
        ok: true,
        key,
        action,
        scene: permit.scene,
        async: true,
        jobId: inflight.id,
        running: true,
        elapsedMs: Date.now() - inflight.startedAt,
        note: `上一张还在画（已 ${ranSec} 秒），这一张没有重新提交。画完会自动发到聊天里，别再调 qq_generate_image。`
      });
      return;
    }
    h.markStart(key);
    const genStartedAt = Date.now();
    const jobId = imageJobId();
    imageJobs.set(key, { id: jobId, startedAt: genStartedAt, prompt });
    log(`[reserved2] 生图入队（${permit.scene}，${key}，${jobId}）：${prompt.slice(0, 60)}`);
    // 立刻回执，回合不再等图。这里必须 ok:true —— 回 ok:false 她会以为失败，转头再画一张。
    sendJson({
      ok: true,
      key,
      action,
      scene: permit.scene,
      async: true,
      jobId,
      etaMs: Math.max(30000, Number(cfg.socialV2?.image?.timeoutMs) || 180000),
      note: '画着呢（通常 40~90 秒，最长 3 分钟）。画完会直接发到聊天里，这一轮不用等，也不要再调 qq_generate_image。'
        + '想知道画到哪了或用它的路径配说说，稍后调 action:"recent"。'
    });
    // 后台跑：画 → 发 → 报备；失败就发一句话说明原因。
    void (async () => {
      let sent = false;
      try {
        const result = isSelfie
          ? await h.generateImageWithRef({ prompt, refPath, size: body.size || (h.selfieCfg ? h.selfieCfg().size : undefined) })
          : await h.generateImageNow({ prompt, size: body.size });
        // 记一笔：异步之后工具只回 jobId，她拿不到路径（MARKER: image-registry）。
        try {
          if (result?.path && typeof h.recordGeneratedImage === 'function') {
            h.recordGeneratedImage({
              path: result.path,
              prompt,
              size: body.size,
              key,
              at: Date.now(),
              kind: isSelfie ? 'selfie' : 'generate',
              scene: isSelfie && selfieInfo ? selfieInfo.keyword || selfieInfo.scene : undefined
            });
          }
        } catch (error) {
          log(`[reserved2] 记录生图产物失败（${key}）：${error?.message ?? error}`);
        }
        // MARKER: image-feedback
        // 她自己得看过这张图：不描述一遍，她只会说「画好了」但完全不知道画面。
        let artDesc = '';
        try {
          if (result?.path && typeof h.describeLocalImageFile === 'function') {
            artDesc = await h.describeLocalImageFile(result.path);
            log(`[image] 自己的图描述完成（${key}）：${String(artDesc).slice(0, 40)}`);
          }
        } catch (error) {
          log(`[image] 描述自己的图失败（${key}）：${error?.message ?? error}`);
        }
        try {
          if (result?.path && artDesc && typeof h.recordGeneratedImage === 'function') {
            h.recordGeneratedImage({
              path: result.path, prompt, size: body.size, key, at: Date.now(),
              kind: isSelfie ? 'selfie' : 'generate', desc: artDesc
            });
          }
          if (artDesc && typeof h.noteSelfImage === 'function') {
            h.noteSelfImage(key, artDesc, result?.path);
          }
        } catch (error) {
          log(`[image] 回灌自己的图失败（${key}）：${error?.message ?? error}`);
        }
        // 画完就发：工具只把 url/本地路径当文本回给模型，她自己看不到图，主人也收不到。
        // 不发等于白画一张，所以默认发。发送失败只记日志，生图结果照常报备。
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
        const costSec = Math.round((Date.now() - genStartedAt) / 1000);
        log(`[reserved2] 生图完成（${key}，${jobId}，${costSec} 秒${sent ? '，已发' : '，未发'}）`);
      } catch (error) {
        const why = String(error?.message ?? error);
        const costSec = Math.round((Date.now() - genStartedAt) / 1000);
        log(`[reserved2] 生图失败（${key}，${jobId}，${costSec} 秒）：${why}`);
        if (reportOnly && typeof h.reportImageUsage === 'function') {
          void h.reportImageUsage({
            key, scene: permit.scene, prompt, size: body.size, ok: false, error: why
          });
        }
        // 失败了得说一声，否则她那边只拿到「画着呢」，会以为图马上就到。
        try {
          const [sendKind, sendId] = String(key).split(':');
          if ((sendKind === 'group' || sendKind === 'private') && Number(sendId) > 0) {
            await h.onebotSend(sendKind, Number(sendId), `画失败了：${why.slice(0, 80)}`, null, null, []);
          }
        } catch (notifyError) {
          log(`[reserved2] 生图失败通知发不出去（${key}）：${notifyError?.message ?? notifyError}`);
        }
      } finally {
        imageJobs.delete(key);
      }
    })();
    return;
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
