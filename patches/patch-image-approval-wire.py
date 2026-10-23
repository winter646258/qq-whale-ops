#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-image-approval-wire.py —— 生图审批（好友私聊要图先问主人）+ 主人私聊跨会话代发

用法：
    python3 patch-image-approval-wire.py [目标 bridge.js]
不给参数时改 /opt/qq-bridge/src/bridge.js（线上）。

--------------------------------------------------------------------------
为什么需要这个补丁
--------------------------------------------------------------------------
需求（主人 2026-10-22 定）：
  ② 允许**从主人私聊**用当前会话令牌往**别的私聊**发送（只限私聊、目标必须是好友）。
  ③ 好友私聊请求生图时，先给管理员（主人）发消息询问，主人确认后才生图。

现状与卡点：
  - `agentTokenOk(key, token)` 要求令牌属于**目标会话**，所以主人私聊的令牌
    发给 `private:3414115838` 一律 403「agent token 无效」。它服务 46 个端点，
    直接改它等于全局放开，所以新增 `agentTokenOkOrOwnerDelegate`，只在
    4 个发送端点（send-message / send-sticker / send-poke / image）替换。
  - `imageSceneFor()` 只认 `owner-private` 和 `owner-group` 两种场景，
    好友私聊恒返回 null → 403。这道闸门**不能拆**（否则谁都能喊一声就让她
    花钱画图），所以在它前面加一层人工审批：登记申请 → 通知主人 →
    主人说「通过」才真画。

--------------------------------------------------------------------------
作用域（踩过坑，写清楚）
--------------------------------------------------------------------------
  bridge.js 是「模块顶层 + 一个巨大的外层函数 + startConsoleServer 内层」三层：
    - 缩进 2（外层）：`cfg` / `currentMode` / `socialV2` / `selfUserId` /
      `onebotSend` / `pending` / `allowed` / `friendSet` / `generateImageNow` /
      `v2ToolEnabled`
    - 缩进 4（startConsoleServer 内层）：`tokenEq` / `agentTokenOk` /
      `isLiveAgentToken`
  所以接线层放**外层**（看得见 onebotSend / generateImageNow / socialV2），
  而 `agentTokenOkOrOwnerDelegate` 必须放**内层**（要看见 agentTokenOk）。
  外层看不见 `tokenEq`，所以代发判定的令牌比较就地用 crypto.timingSafeEqual。

--------------------------------------------------------------------------
坑（写在这里免得下次重踩）
--------------------------------------------------------------------------
  - `apply()` 是**替换**语义：addition 必须自己把锚点行原样带回去。
  - 带锚点插入必须断言锚点唯一性 —— 曾经把 `if (reason === 'poke') {` 复制成
    两层，`node --check` 照样通过，但所有非 poke 的分支都返回 undefined。
  - **每个 apply 的 marker 必须互不相同**：共用 marker 会让第 2 处起全被
    当成「已装」跳过（这个补丁第一版就这么废的）。
"""

import sys
import io

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'

with io.open(TARGET, 'r', encoding='utf-8') as f:
    SRC = f.read()

changed = []


def ensure(cond, msg):
    if not cond:
        print('FAIL: ' + msg)
        sys.exit(1)


def apply(marker, anchor, addition, label, expect=1):
    """装一段代码。marker 已存在则跳过（幂等）；anchor 必须恰好命中 expect 次。"""
    global SRC
    if marker in SRC:
        print('  - %s：已装，跳过' % label)
        return
    n = SRC.count(anchor)
    ensure(n == expect, '%s 的锚点命中 %d 次（期望 %d）：%r' % (label, n, expect, anchor[:100]))
    SRC = SRC.replace(anchor, addition, 1)
    changed.append(label)


# ── 1. import ─────────────────────────────────────────────────────────────
apply('// MARKER: image-approval-import', "} from './share-signal-store.js';", r"""} from './share-signal-store.js';

// MARKER: image-approval-import
// 生图审批：好友私聊要图先问主人。状态机在 image-approval-store.js（纯逻辑），
// 这里只负责接 QQ 和落盘。
import {
  createApproval as createImageApproval,
  approveApproval as approveImageApproval,
  rejectApproval as rejectImageApproval,
  pickPendingToDecide as pickImageApprovalToDecide,
  listPending as listPendingImageApprovals,
  pendingCount as pendingImageApprovalCount,
  expireStale as expireStaleImageApprovals,
  statsOf as imageApprovalStatsOf,
  loadApprovalState as loadImageApprovalState,
  saveApprovalState as saveImageApprovalState,
  createDefaultState as createDefaultImageApprovalState,
  APPROVAL_TTL_MS as IMAGE_APPROVAL_TTL_MS,
  MAX_PROMPT_CHARS as IMAGE_APPROVAL_MAX_PROMPT
} from './image-approval-store.js';""", 'import')

# ── 2. 状态文件常量 ────────────────────────────────────────────────────────
apply('// MARKER: image-approval-file',
      "const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');  // MARKER: share-signal-file",
      r"""const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');  // MARKER: share-signal-file
// MARKER: image-approval-file
const IMAGE_APPROVAL_FILE = path.join(STATE_DIR, 'image-approval.json');""",
      '状态文件路径')

# ── 3. 接线层（外层，插在 v2ToolEnabled 之前）──────────────────────────────
WIRE = r"""  // MARKER: image-approval-wire
  // ══════════════════════════════════════════════════════════════════════
  // 生图审批 + 主人私聊跨会话代发
  //
  // 两件事共用一层，因为数据流是同一条：
  //   好友私聊要图 → 产生一条申请 → 通知主人 → 主人确认 → 桥接直接出图发给好友。
  //   主人私聊代发让那条令牌能写到好友会话（否则连通知都发不出去）。
  // ══════════════════════════════════════════════════════════════════════

  /** 审批状态的内存缓存。改盘上的 json 不会立刻生效，要重启（踩过一次）。 */
  let imageApprovalCache = null;
  // 好友昵称表（号码 -> 昵称），由 refreshFriends 填。不落盘。
  const friendNames = new Map();
  const IMAGE_APPROVAL_AUDIT_FILE = path.join(STATE_DIR, 'image-approval-audit.jsonl');

  function loadImageApprovalOrNull() {
    try {
      return loadImageApprovalState(IMAGE_APPROVAL_FILE);
    } catch (error) {
      // 读不动就吵出来：静默当空库会把主人的审批历史覆盖掉。
      log(`[imgapprove] 读审批状态失败：${error?.message ?? error}`);
      return null;
    }
  }

  function getImageApprovalState() {
    if (!imageApprovalCache) {
      imageApprovalCache = loadImageApprovalOrNull() || createDefaultImageApprovalState();
    }
    return imageApprovalCache;
  }

  function appendImageApprovalAudit(entry) {
    try {
      fs.appendFileSync(IMAGE_APPROVAL_AUDIT_FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n', { mode: 0o600 });
    } catch (error) {
      log(`[imgapprove] 写审计失败：${error?.message ?? error}`);
    }
  }

  function persistImageApproval(action, detail = '') {
    if (!imageApprovalCache) return;
    try {
      saveImageApprovalState(IMAGE_APPROVAL_FILE, imageApprovalCache);
    } catch (error) {
      log(`[imgapprove] 落盘失败：${error?.message ?? error}`);
    }
    appendImageApprovalAudit({ action, detail });
  }

  /** 主人私聊的 key（审批通知都往这里发）。 */
  function imageApprovalOwnerKey() {
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    return ownerQQ ? `private:${ownerQQ}` : null;
  }

  /**
   * 这个会话能不能走审批要图？
   *
   * 硬条件：是 private:<id>、不是主人、不是她自己、是好友、且过当前模式准入。
   * 少一条都不行 —— 判宽了等于给所有人开了花钱的口子。
   */
  function imageApprovalEligible(key) {
    const m = /^private:(\d+)$/.exec(String(key ?? '').trim());
    if (!m) return false;
    const id = String(Number(m[1]));
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ || id === ownerQQ) return false;
    if (selfUserId && id === String(selfUserId)) return false;
    if (!friendSetReady || !friendSet.has(id)) return false;
    if (!allowed('private', Number(id), cfg)) return false;
    return true;
  }

  /**
   * 好友昵称表（号码 -> 昵称）。
   *
   * 为什么要这张表：私聊会话的 recentMessages 里 sender 恒为
   * 「我」或「私聊」（对方的真实昵称从不写进去），所以从会话里抖不出名字。
   * 而 refreshFriends 拿到的 get_friend_list 本来就带 nickname，只是过去只取了
   * user_id 就把昵称丢了。这张表由 refreshFriends 顺手填。
   */
  function rememberFriendNames(list) {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const id = String(f?.user_id ?? '').trim();
      if (!id) continue;
      const name = String(f?.nickname ?? f?.remark ?? '').trim();
      if (!name) continue;
      friendNames.set(id, name.slice(0, 32));
    }
  }

  /** 申请人的显示名（通知主人时用；拿不到就退回号码）。 */
  function imageApprovalRequesterName(id) {
    const sid = String(id ?? '').trim();
    // 好友表里的昵称最准。
    const known = friendNames.get(sid);
    if (known) return known;
    try {
      const st = socialV2.conversations.get(`private:${sid}`);
      const rec = Array.isArray(st?.recentMessages) ? st.recentMessages.slice(-30).reverse() : [];
      for (const item of rec) {
        const name = String(item?.sender ?? '').trim();
        // 「我」「私聊」「对方」都是占位符，不是名字。
        if (name && name !== '我' && name !== '私聊' && name !== '对方' && name !== sid) return name;
      }
    } catch { /* 拿不到就算了，用号码 */ }
    return sid;
  }

  /** 直接往 QQ 发一条文本（不触发模型回合，省钱）。 */
  async function sendPlainToQQ(key, text) {
    const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
    if (!m) throw new Error(`sendPlainToQQ: key 格式不对：${key}`);
    const id = Number(m[2]);
    if (!Number.isFinite(id) || id <= 0) throw new Error(`sendPlainToQQ: id 不合法：${key}`);
    await onebotSend(m[1], id, String(text));
  }

  /** 通知主人：有人要图，等你点头。 */
  async function notifyOwnerImageRequest(approval) {
    const ownerKey = imageApprovalOwnerKey();
    if (!ownerKey) {
      log('[imgapprove] 没配 ownerQQ，没法通知主人');
      return false;
    }
    const who = approval.requesterName || approval.key.replace(/^private:/, '');
    const minutes = Math.round(IMAGE_APPROVAL_TTL_MS / 60000);
    const text = [
      `【有人想要图】${who}（${approval.key.replace(/^private:/, '')}）`,
      `要画：${approval.prompt}`,
      approval.size ? `尺寸：${approval.size}` : '',
      `回「通过」就开始画，回「拒绝」就不画。${minutes} 分钟内有效，编号 ${approval.id}。`
    ].filter(Boolean).join('\n');
    try {
      await sendPlainToQQ(ownerKey, text);
      appendImageApprovalAudit({ action: 'notify', detail: `${approval.id} → 主人` });
      return true;
    } catch (error) {
      log(`[imgapprove] 通知主人失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 好友私聊要图 → 登记一条申请（不发图）。
   *
   * 同一句 prompt 重复要（催）只续期、不再通知主人 —— 否则好友连敲三次
   * 就是三条申请，主人被刷屏。
   */
  function requestImageApproval(key, prompt, size) {
    const st = getImageApprovalState();
    const idMatch = /^private:(\d+)$/.exec(String(key ?? '').trim());
    if (!idMatch) return { ok: false, error: '只有好友私聊能申请生图' };
    const id = String(Number(idMatch[1]));
    const created = createImageApproval(st, {
      key,
      requesterName: imageApprovalRequesterName(id),
      prompt,
      size
    });
    if (!created.approval) {
      const msg = created.reason === 'too-many-pending'
        ? '待审批的图太多了，等主人处理完再说'
        : created.reason === 'no-prompt'
          ? 'prompt 不能为空'
          : '申请格式不对';
      return { ok: false, error: msg };
    }
    persistImageApproval(created.reused ? 'request-again' : 'request', `${created.approval.id} ${key}`);
    log(`[imgapprove] ${created.reused ? '重复申请（已续期）' : '收到生图申请'}（${key}）：${String(prompt).slice(0, 50)}`);
    if (!created.reused) {
      // 通知失败不回滚申请：主人下次问起还能看到这条。
      void notifyOwnerImageRequest(created.approval).catch(() => {});
    }
    return {
      ok: true,
      approval: created.approval,
      reused: created.reused,
      note: created.reused
        ? `已经在等主人确认了（编号 ${created.approval.id}），不会再催一次。`
        : `已经把请求转给主人了（编号 ${created.approval.id}），等主人点头才画。`
    };
  }

  /** 审批通过 → 真出图 → 直接发给申请的好友。 */
  async function commitApprovedImageApproval(approval) {
    const ownerKey = imageApprovalOwnerKey();
    try {
      log(`[imgapprove] 主人已通过 ${approval.id}，开始出图（${approval.key}）：${String(approval.prompt).slice(0, 50)}`);
      const result = await generateImageNow({ prompt: approval.prompt, size: approval.size || undefined });
      let sent = false;
      try {
        if (result?.path) {
          const [sendKind, sendId] = String(approval.key).split(':');
          if ((sendKind === 'group' || sendKind === 'private') && Number(sendId) > 0) {
            await onebotSend(sendKind, Number(sendId), '', null, null, [result.path]);
            sent = true;
          }
        }
      } catch (error) {
        log(`[imgapprove] 出图后发送失败（${approval.key}）：${error?.message ?? error}`);
      }
      appendImageApprovalAudit({ action: 'generated', detail: `${approval.id} sent=${sent}` });
      if (ownerKey) {
        await sendPlainToQQ(ownerKey, sent
          ? `✅ ${approval.requesterName || approval.key} 的图已经画好发出去了（${approval.id}）。`
          : `⚠️ ${approval.id} 画好了但没能发出去，你看下日志。`).catch(() => {});
      }
      return { ok: true, sent };
    } catch (error) {
      log(`[imgapprove] 出图失败（${approval.id}）：${error?.message ?? error}`);
      appendImageApprovalAudit({ action: 'generate-failed', detail: `${approval.id} ${error?.message ?? error}` });
      if (ownerKey) {
        await sendPlainToQQ(ownerKey, `❌ ${approval.id} 出图失败：${error?.message ?? error}`).catch(() => {});
      }
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 主人在私聊里回「通过 / 拒绝」时消费一条审批。
   *
   * 返回 true 表示这句话被审批吃掉了（不再往下走模型）。
   * 没有待审申请时返回 false —— 主人平时说「通过」不该被拦。
   */
  function tryConsumeImageApprovalReply(key, text) {
    if (!/^private:(\d+)$/.test(String(key ?? ''))) return false;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ || String(key) !== `private:${ownerQQ}`) return false;
    const raw = String(text ?? '').trim();
    if (!raw) return false;

    const st = getImageApprovalState();
    expireStaleImageApprovals(st);
    if (pendingImageApprovalCount(st) === 0) return false;

    // 支持「通过 ia3f2」指定编号；不指定就取最新那条。
    const idHit = /\b(ia[0-9a-z]+)\b/i.exec(raw);
    const explicitId = idHit ? idHit[1] : '';
    const bare = raw.replace(/\bia[0-9a-z]+\b/gi, '').replace(/[#＃]/g, '').replace(/[。，！!.、\s@]/g, '').toLowerCase();
    if (!bare) return false;

    let want = '';
    if (APPROVE_WORDS.has(bare)) want = 'approve';
    else if (REJECT_WORDS.has(bare)) want = 'reject';
    if (!want) return false;

    const target = pickImageApprovalToDecide(st, { id: explicitId });
    if (!target) {
      void sendPlainToQQ(key, '没找到待审批的生图申请（可能已经过期或处理过了）。').catch(() => {});
      return true;
    }

    if (want === 'approve') {
      const res = approveImageApproval(st, target.id);
      if (!res.ok) {
        void sendPlainToQQ(key, `这条申请已经不能通过了（${res.reason === 'expired' ? '已过期' : res.reason}）。`).catch(() => {});
        return true;
      }
      persistImageApproval('approved', `${target.id} ${target.key}`);
      log(`[imgapprove] 主人通过 ${target.id}（${target.key}）`);
      // 出图要几十秒到几分钟，不能卡住消息处理。
      void commitApprovedImageApproval(res.approval).catch(() => {});
      void sendPlainToQQ(key, `好，开始画（${target.id}），画好会直接发给${target.requesterName || '对方'}。`).catch(() => {});
      return true;
    }

    const rej = rejectImageApproval(st, target.id);
    if (!rej.ok) {
      void sendPlainToQQ(key, `这条申请已经不能拒绝了（${rej.reason}）。`).catch(() => {});
      return true;
    }
    persistImageApproval('rejected', `${target.id} ${target.key}`);
    log(`[imgapprove] 主人拒绝 ${target.id}（${target.key}）`);
    void sendPlainToQQ(key, `好，不画了（${target.id}）。`).catch(() => {});
    return true;
  }

  /**
   * 「主人私聊的令牌可以代发到好友私聊」的判定。
   *
   * 这里是**外层**，看不见 startConsoleServer 里的 tokenEq，所以令牌比较
   * 就地用 crypto.timingSafeEqual（同一个理由：定长比较，不给时延试探）。
   *
   * 边界（缺一不可）：
   *   - 令牌必须属于 `private:<ownerQQ>` 这个会话，别的一律不认；
   *   - 目标必须也是私聊，群里不许跨会话发（群里冒名代价太大）；
   *   - 目标必须是好友、且过当前模式准入；
   *   - 目标不能是主人自己，也不能是她自己。
   */
  function ownerDelegateTokenOk(key, token) {
    if (typeof token !== 'string' || !token) return false;
    const target = canonicalV2Key(key);
    if (!target) return false;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) return false;
    const m = /^private:(\d+)$/.exec(target);
    if (!m) return false;
    const id = String(Number(m[1]));
    if (id === ownerQQ) return false;
    if (selfUserId && id === String(selfUserId)) return false;
    if (!friendSetReady || !friendSet.has(id)) return false;
    if (!allowed('private', Number(id), cfg)) return false;
    const ownerSt = socialV2.conversations.get(`private:${ownerQQ}`);
    const stored = ownerSt?.agentToken;
    if (typeof stored !== 'string' || !stored) return false;
    const x = Buffer.from(stored, 'utf8');
    const y = Buffer.from(token, 'utf8');
    if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return false;
    log(`[delegate] 主人私聊代发 → ${target}`);
    return true;
  }

  function v2ToolEnabled(flag) {"""
apply('// MARKER: image-approval-wire', "  function v2ToolEnabled(flag) {", WIRE, '接线层')

# ── 4. agentTokenOkOrOwnerDelegate（内层，紧跟 agentTokenOk）──────────────
apply('// MARKER: image-approval-adelegate', """    /**
     * 令牌是否匹配**任意**一个活跃二代会话。""", r"""    // MARKER: image-approval-adelegate
    // 主人私聊的令牌可以代发到好友私聊（边界见 ownerDelegateTokenOk）。
    // 只给 4 个发送端点用；其余端点仍走严格的 agentTokenOk。
    const agentTokenOkOrOwnerDelegate = (key, token) => {
      if (agentTokenOk(key, token)) return true;
      try { return ownerDelegateTokenOk(key, token); } catch { return false; }
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。""", '代发令牌校验')

# ── 5/6/7/8. 四个发送端点换成可代发版本（各自独立 marker）──────────────────
apply('// MARKER: image-approval-ep-msg', """          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) {""",
      """          if (req.headers['x-agent-token'] && !agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-msg
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) {""",
      'send-message 代发')

apply('// MARKER: image-approval-ep-sticker', """          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) {""",
      """          if (req.headers['x-agent-token'] && !agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-sticker
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) {""",
      'send-sticker 代发')

apply('// MARKER: image-approval-ep-poke', """          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) {""",
      """          if (!agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-poke
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) {""",
      'send-poke 代发')

apply('// MARKER: image-approval-ep-image', """            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('image')) {""",
      """            if (req.headers['x-agent-token'] && !agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-image
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('image')) {""",
      'image 代发')

# ── 8b. image 端点的审批分支 ──────────────────────────────────────────────
apply('// MARKER: image-approval-gate', """            const permit = imageAllowedNow(key);
            if (!permit.ok) { sendJson({ ok: false, error: permit.why }, 403); return; }""", r"""            const permit = imageAllowedNow(key);
            if (!permit.ok) {
              // MARKER: image-approval-gate
              // 好友私聊要图：不画，转成一条待审申请发给主人。其余场景仍照旧 403。
              if (action === 'generate' && imageApprovalEligible(key)) {
                const reqPrompt = String(body.prompt ?? '').trim();
                if (!reqPrompt) { sendJson({ ok: false, error: 'prompt 不能为空' }, 400); return; }
                if (reqPrompt.length > IMAGE_APPROVAL_MAX_PROMPT) {
                  sendJson({ ok: false, error: `prompt 太长（上限 ${IMAGE_APPROVAL_MAX_PROMPT} 字）` }, 400);
                  return;
                }
                const requested = requestImageApproval(key, reqPrompt, String(body.size ?? '').trim());
                if (!requested.ok) { sendJson({ ok: false, error: requested.error }, 409); return; }
                sendJson({
                  ok: true,
                  key,
                  action,
                  status: 'pending-approval',
                  approvalId: requested.approval.id,
                  reused: requested.reused,
                  ttlMs: IMAGE_APPROVAL_TTL_MS,
                  note: requested.note
                });
                return;
              }
              sendJson({ ok: false, error: permit.why }, 403); return;
            }""", '生图审批分支')

# ── 9. HTTP 端点 ──────────────────────────────────────────────────────────
apply('// MARKER: image-approval-route', """        // ── 日程 / 画像：角色的短期记忆与长期认识 ──────────────────────────""", r"""        // MARKER: image-approval-route
        // 生图审批的查询与人工处置入口（控制台/管理端用；智能体侧走 QQ 里的
        // 「通过 / 拒绝」，不从这里批）。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/image-approval') {
          try {
            const q = url.searchParams;
            const body = req.method === 'POST' ? await readBody() : {};
            const action = String(body.action ?? q.get('action') ?? 'list').trim();
            const st = getImageApprovalState();
            if (action === 'list' || action === 'stats') {
              const stats = imageApprovalStatsOf(st);
              sendJson({ ok: true, action, ...stats });
              return;
            }
            if (action === 'approve' || action === 'reject') {
              const id = String(body.id ?? q.get('id') ?? '').trim();
              if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
              const res = action === 'approve'
                ? approveImageApproval(st, id)
                : rejectImageApproval(st, id);
              if (!res.ok) { sendJson({ ok: false, error: res.reason }, 409); return; }
              persistImageApproval(action, `${id} ${res.approval.key}`);
              log(`[imgapprove] 人工 ${action} ${id}（${res.approval.key}）`);
              if (action === 'approve') {
                void commitApprovedImageApproval(res.approval).catch(() => {});
              }
              sendJson({ ok: true, action, approval: res.approval });
              return;
            }
            sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 list / approve / reject / stats）' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: '生图审批操作失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }

        // ── 日程 / 画像：角色的短期记忆与长期认识 ──────────────────────────""", 'HTTP 端点')

# ── 10. handleIncoming 消费主人的「通过 / 拒绝」 ──────────────────────────
apply('// MARKER: image-approval-consume', """    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }""", r"""    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // MARKER: image-approval-consume
    // 主人在私聊里回「通过 / 拒绝」= 处置一条生图申请。
    // 放在 DSH 挂起问答之后：那边有挂起时先让那边的「通过」生效，别抢。
    if (isOwner && plainContent) {
      try {
        if (tryConsumeImageApprovalReply(key, plainContent)) return;
      } catch (error) {
        log(`[imgapprove] 处理主人审批回话失败：${error?.message ?? error}`);
      }
    }""", '消费主人审批回话')

# ── 落盘 ──────────────────────────────────────────────────────────────────
# ── 12. refreshFriends 順手记好友昵称（供审批通知显示真名）──
apply('// MARKER: image-approval-friendnames', """        const next = new Set(list.map((f) => String(f?.user_id ?? '')).filter(Boolean));""",
      """        rememberFriendNames(list);  // MARKER: image-approval-friendnames
        const next = new Set(list.map((f) => String(f?.user_id ?? '')).filter(Boolean));""",
      '好友昵称表')

with io.open(TARGET, 'w', encoding='utf-8') as f:
    f.write(SRC)

print('\n已改动：' + ('、'.join(changed) if changed else '（无，全部已装）'))
print('文件大小：%d 字节' % len(SRC.encode('utf-8')))
