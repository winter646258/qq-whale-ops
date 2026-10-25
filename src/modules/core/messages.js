import { rejectAi } from './shared.js';

// ── v2:messages：她读消息的四条通道 ────────────────────────────────────────
//
// 这一族全部是**她自己在用**的读接口，鉴权口径统一为：
//   只有带了 x-agent-token 才校验
//     agentTokenOk(key, token)  → 会话令牌对不对
//     v2SessionAllowed(key)     → 这个会话在当前模式下允不允许
//     v2ToolEnabled('<flag>')   → 这个工具被主人单独关掉没有
//   不带令牌 = 控制台自己看（集中闸门已验过控制台令牌）。
//
// 为什么这里绝不套 rejectAgent：这些接口就是 AI 的工作通道，把它们挡在门外
// 等于让她读不到消息。反过来，也正因为如此，每一条都必须自己把上面三道门走完
// —— 集中闸门对 /api/socialV2/* 是放行给 agent 的，不会替我们做这件事。
//
// readThroughSeq 的语义（容易改错，别动）：带 agent token 时调
// noteModelMessagesV2(st, messages) —— 记一笔「模型看过这些」，返回推进后的游标；
// 不带令牌时调 readThroughSeqV2(st) —— 只读游标，不记账。互换会让未读计数乱掉。

async function listUnread({ req, url, sendJson }) {
  const h = this.ctx.coreHelpers;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'getUnread', what: 'qq_get_unread_messages' })) return;

  const afterRaw = url.searchParams.get('afterSeq');
  const afterSeq = afterRaw === null ? null : Number(afterRaw);
  if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
    sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
    return;
  }

  const st = h.getSocialV2State(key);
  // 默认读尾巴（老行为）；给了 afterSeq 就走游标翻页，积压超过一次响应也能读完。
  const messages = afterSeq === null
    ? st.unread.slice(-limit)
    : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
  const readThroughSeq = req.headers['x-agent-token'] ? h.noteModelMessages(st, messages) : h.readThroughSeq(st);
  sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
}

function listRecent({ req, url, sendJson }) {
  const h = this.ctx.coreHelpers;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'getRecent', what: 'qq_get_recent_messages' })) return;

  const st = h.getSocialV2State(key);
  const start = Math.max(0, st.recentMessages.length - offset - limit);
  const end = Math.max(0, st.recentMessages.length - offset);
  const messages = st.recentMessages.slice(start, end);
  const readThroughSeq = req.headers['x-agent-token'] ? h.noteModelMessages(st, messages) : h.readThroughSeq(st);
  sendJson({ ok: true, key, messages, readThroughSeq });
}

async function markRead({ req, sendJson, readBody }) {
  const h = this.ctx.coreHelpers;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'markRead', what: 'qq_mark_read' })) return;

  const st = h.getSocialV2State(key);
  const throughSeq = h.requestedReadThroughSeq(st, body, !!req.headers['x-agent-token']);
  // 当前已经是「潜水」配置、且最近还有对话/刚被唤醒时，不允许用 mark_read 直接回到潜水：
  // 必须先等够沉睡前观察窗口，否则就是「聊两句又去潜水」。
  if (h.isSleepingConfig(st.wakeConfig) && h.preSleepWaitBlocked(st)) {
    const preSleepMs = Math.max(0, Number(this.ctx.cfg.socialV2?.wake?.preSleepWaitMs) || 90000);
    const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
    const remainMin = Math.ceil(remaining / 60000);
    sendJson({
      ok: false,
      error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
      preSleepWaitMs: preSleepMs,
      preSleepWaitRemainingMs: remaining,
    }, 400);
    return;
  }

  const markedCount = h.acknowledgeMessages(st, throughSeq);
  st.lastActionAt = Date.now();
  st.wakeConfig.noActionCount = 0;
  // 防止「有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾」造成无定时器、
  // 无触发条件的静默态。
  if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
    st.wakeConfig.infinite = true;
  }
  h.ensureWakeable(st, { key });
  st.wakeConfig.confirmedAt = Date.now();
  st.wakeConfig.confirmedBy = 'mark_read';
  h.markReadCalledKeys().add(key);
  h.saveSocialV2State();
  this.ctx.log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
  sendJson({
    ok: true,
    key,
    markedCount,
    unreadCount: st.unread.length,
    readThroughSeq: h.readThroughSeq(st),
    wakeGuaranteed: h.wakeSafety(st.wakeConfig).guaranteed,
    wakeSafety: h.wakeSafety(st.wakeConfig),
    wakeConfig: st.wakeConfig,
  });
}

async function messageDetail({ req, url, sendJson }) {
  const h = this.ctx.coreHelpers;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const messageId = String(url.searchParams.get('messageId') ?? '').trim();
  if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'getMessageDetail', what: 'qq_get_message_detail' })) return;

  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  try {
    const st = h.getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
    const forwardFields = found
      ? { forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [], hasForward: !!found.hasForward }
      : {};
    let info = null;
    // 入参命中本地 seq 且本地存有真实 messageId 时优先用本地的，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== messageId) {
      info = {
        sender: String(found.sender || ''),
        text: String(found.text || found.plain || '').slice(0, 200),
        userId: found.userId ? String(found.userId) : null,
        messageId: String(found.messageId),
        seq: found.seq,
      };
    } else {
      info = await h.resolveReplyInfo(kind, id, messageId);
      if (!info && found) {
        info = {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: found.userId ? String(found.userId) : null,
          messageId: found.messageId ? String(found.messageId) : null,
          seq: found.seq,
        };
      }
    }
    // 不管 info 来自本地还是 OneBot，本地有 found 就补上转发字段，别让提示词和实现打架。
    if (info && found) Object.assign(info, forwardFields);
    // 正文本就是 200 字符预览；显式告知截断，免得模型把预览当全文。
    if (info) info.textTruncated = String(info.text ?? '').length >= 200;
    sendJson({ ok: true, key, messageId, info });
  } catch (error) {
    sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
  }
}

export const messageRoutes = [
  { method: 'GET', kind: 'exact', path: '/api/socialV2/unread', handler: listUnread },
  { method: 'GET', kind: 'exact', path: '/api/socialV2/recent', handler: listRecent },
  { method: 'POST', kind: 'exact', path: '/api/socialV2/mark-read', handler: markRead },
  { method: 'GET', kind: 'exact', path: '/api/socialV2/message-detail', handler: messageDetail },
];
