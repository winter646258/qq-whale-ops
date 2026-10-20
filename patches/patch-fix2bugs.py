"""修两个 bug：

── Bug 1：印象维护的两个计时字段从来没被存盘 ──────────────────────────────
`lastImpressionRefreshAt` / `lastImpressionNudgeAt` 在 loadSocialV2State 里读、
在 new-session 初始化里给默认值，但 **saveSocialV2State 的字段清单里没有它们**。

后果（实测）：状态文件里这两个字段是 undefined ⇒ 「印象维护」（7 天提醒重写）
永远触发不了；「记印象」驱动的 12 小时冷却也永远失效（每次重启清零）。
这正是交接文档待办 #7「印象只增不减」的根因。

修法：save 里补两行。同时补一个**语义陷阱**的修正 —— load 时若字段缺失，
旧逻辑给 `lastImpressionRefreshAt = Date.now()`（即「刚刷新过」），
这会让「从未刷新过」和「刚刷新过」不可区分，7 天提醒依然永远不来。
改成给 0（从未刷新），并让判断逻辑把 0 明确当作「从未刷新」。

── Bug 2：黑话研究有两个断点 ──────────────────────────────────────────────
a) `魔了` / `lt` 这两条 count 已到阈值 2，`lastInferenceCount` 仍是 0，
   说明它们**从没进过研究批次**。根因：研究失败（21:07/21:12 那两条
   「学习会话 turn 未正常完成：error」）后 `lastInferenceCount` 不前进是对的，
   但队列只在该条**再次出现**时才重新入队；一条不再出现的词就永久卡住。
   修法：加一个「补偿扫描」——每轮提取后，把「达到阈值但没研究过」的候选
   补进研究队列（不依赖它再次出现）。

b) 更根本的：`batch-confirm` 要求条目必须有 `meaning`，否则跳过。
   而 240 条里 235 条没有释义（因为阈值是 2/4/8，只出现过一次的词
   永远不会被研究）。所以这些词**永远不可能被确认**，
   即使人工在控制台里点确认也会被跳过。
   修法：研究阈值支持 1（配置 `inferenceThresholds: [1,2,4,8]`），
   让单次出现的词也能拿到释义；同时把「缺释义」的跳过原因说得更明确。

回滚：
  cp src/bridge.js.bak-fix2bugs-<stamp> src/bridge.js
  systemctl restart qq-bridge
"""
import os
import shutil
import time

BRIDGE = os.environ.get('QQ_BRIDGE_SRC') or '/opt/qq-bridge/src/bridge.js'
MARKER = 'MARKER: fix2bugs'

src = open(BRIDGE, encoding='utf-8', newline='').read()
if MARKER in src:
    print('[skip] 已打过')
    raise SystemExit(0)


def sub_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'[x] 锚点「{label}」匹配 {n} 次（预期 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1)


# ══ Bug 1-a：save 里补两个字段 ══════════════════════════════════════════
src = sub_once(
    src,
    """          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)""",
    """          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          // MARKER: fix2bugs
          // 印象维护的两个计时字段必须落盘，否则每次重启都丢：
          //   lastImpressionRefreshAt 丢了 ⇒ 「7 天提醒重写印象」永远不来
          //   lastImpressionNudgeAt   丢了 ⇒ 「记印象」驱动的 12 小时冷却永远失效
          // 这是交接文档待办 #7「印象只增不减」的根因（此前只在 load 里读到过）。
          lastImpressionRefreshAt: Number(st.lastImpressionRefreshAt) || 0,
          lastImpressionNudgeAt: Number(st.lastImpressionNudgeAt) || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)""",
    'save 补印象计时字段'
)

# ══ Bug 1-b：load 缺失时给 0（从未刷新），而不是 Date.now() ═════════════
src = sub_once(
    src,
    """            // 印象维护计时。默认给「现在」：宁可第一次提醒晚一轮，
            // 也绝不因为字段缺失而每轮唤醒都唠叨一次。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : Date.now(),""",
    """            // 印象维护计时。**默认给 0 = 「从未刷新过」**，不是「现在」。
            // 旧逻辑给 Date.now() 是想避免每轮唠叨，但副作用是「从未刷新」和
            // 「刚刷新过」变得不可区分 ⇒ 7 天提醒**永远**不会来（实测就是这个结果）。
            // 真正的防唠叨由 lastImpressionNudgeAt 的冷却负责，不该靠伪造刷新时间。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : 0,""",
    'load 默认值改 0'
)

# ══ Bug 1-c：新建会话初始化也用 0 ════════════════════════════════════════
src = sub_once(
    src,
    """        lastImpressionRefreshAt: Date.now(),
        lastImpressionNudgeAt: 0""",
    """        // 与 load 保持一致：0 = 从未刷新过（不是「刚刚刷新过」）
        lastImpressionRefreshAt: 0,
        lastImpressionNudgeAt: 0""",
    '新建会话默认值'
)

# ══ Bug 2-a：研究队列补偿扫描 ════════════════════════════════════════════
# 原逻辑只在该条**再次出现**时才入队。一条不再出现的词会永久卡在
# 「达到阈值但从未研究」。
#
# ⚠️ 第一版补丁把扫描写在「提取成功」的路径里 ⇒ 实测没触发：
#    21:37 那次是「未发现候选」，之后也没有新的提取，补偿永远等不到。
#    这里改成**独立函数**，由「提取后」和「启动后」两处调用。
src = sub_once(
    src,
    """      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }""",
    """      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
      // MARKER: fix2bugs
      // 补偿扫描：与本次是否提取到候选无关，独立补「从未研究过」的。
      sweepUnresearchedSlang();""",
    '补偿扫描调用点'
)

# 真正的实现：放在 runSlangResearch 之前
src = sub_once(
    src,
    """  async function runSlangResearch(candidates) {""",
    """  // MARKER: fix2bugs
  // 补偿扫描：把「已达研究阈值、但从未研究过」的候选补进队列。
  //
  // 为什么需要：正常入队只在该条**再次出现**时触发；一条达到阈值后不再出现的词
  // 会永久卡住（实测「魔了」「lt」count=2、lastInferenceCount=0，从没被研究过）。
  // 研究失败（如 21:07/21:12 的「学习会话 turn 未正常完成」）后也一样能靠这里补上。
  //
  // 为什么单独成函数：第一版写在「提取成功」分支里，实测因「未发现候选」而永不触发。
  // 现在由「每次提取后」和「服务启动后」两处调用，不依赖刚好有新词。
  function sweepUnresearchedSlang({ reason = '' } = {}) {
    try {
      if (cfg.slang?.autoResearch === false) return 0;
      if (!Array.isArray(slangEntries) || !slangEntries.length) return 0;
      const thresholdsC = Array.isArray(cfg.slang?.inferenceThresholds)
        ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean)
        : [2, 4, 8];
      const maxThreshold = thresholdsC.length ? Math.max(...thresholdsC) : 8;
      const pending = slangEntries.filter((e) => {
        if (!e || e.status !== SLANG_STATUS.CANDIDATE) return false;
        const c = Number(e.count) || 0;
        const done = Number(e.lastInferenceCount) || 0;
        if (c < 1 || done >= c) return false;
        // 只补「已经到过某个阈值」的，避免把所有 count=1 的词一次性全塞进队列
        if (c > maxThreshold) return true;
        return thresholdsC.includes(c);
      });
      // 一次最多补 5 条，别把学习会话压垮。
      const batch = pending.slice(0, 5).filter((e) => !slangResearchingIds.has(e.id));
      if (!batch.length) return 0;
      log(`黑话研究：补偿扫描补入 ${batch.length} 条从未研究的候选${reason ? `（${reason}）` : ''}`);
      queueSlangTask(() => runSlangResearch(batch));
      return batch.length;
    } catch (error) {
      log('黑话补偿扫描异常:', error?.message ?? error);
      return 0;
    }
  }

  async function runSlangResearch(candidates) {""",
    '补偿扫描实现'
)

# ══ Bug 2-a（续）：启动后补一次扫描 ═════════════════════════════════════
# 只靠「提取后」调用不够：实测 21:37「未发现候选」之后没有新的提取，
# 补偿永远等不到触发机会。启动后延迟 30 秒补一次（等 DSH/学习会话就绪）。
src = sub_once(
    src,
    """  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  await pumpMux();""",
    """  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  // MARKER: fix2bugs
  // 启动后补一次黑话研究。为什么不能只靠「提取后」触发：
  // 实测 21:37 那次是「未发现候选」，之后没有新提取 ⇒ 补偿永远等不到机会。
  // 延迟 30 秒，等 DSH 与学习会话就绪，避免启动瞬间抢会话资源。
  setTimeout(() => {
    try { sweepUnresearchedSlang({ reason: '启动补偿' }); } catch (error) {
      log('启动补偿扫描异常:', error?.message ?? error);
    }
  }, 30000);

  await pumpMux();""",
    '启动时补偿扫描'
)

# ══ Bug 2-b：batch-confirm 跳过原因更明确 ═══════════════════════════════
src = sub_once(
    src,
    """            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }""",
    """            if (!entry.meaning || !String(entry.meaning).trim()) {
              // MARKER: fix2bugs
              // 说清楚为什么不能确认：提示词里要显示「词：含义」，没有含义的条目
              // 即使确认了也不会进黑话表（buildSlangContext 会把它过滤掉），
              // 等于白确认。这里给出可操作的下一步，而不是只报「缺少含义」。
              skippedCount++;
              skipped.push({
                id,
                content: entry.content,
                count: Number(entry.count) || 0,
                reason: '缺少含义：请先等 AI 研究出释义（或手动补 meaning）再确认，否则确认了也不会进黑话表'
              });
              continue;
            }""",
    'batch-confirm 原因说明'
)

# ══ Bug 1-d：interactionCount 从不自增 ═══════════════════════════════════
# 实测：6 条印象的 interactionCount 全是 1。全代码里只有两处写它：
#   - appendMemoryV2 新建时给 1
#   - memory-update 端点手动传值时改
# 所以「互动次数」永远停在第一次记印象的那一刻，而它正是判断「这条印象
# 该不该重写」的依据之一（印象越久没更新越该重写）。这是待办 #7 的另一半。
#
# 修法：有人发消息 / 拍一拍就给他已有的印象 +1。**只给已有印象的人加**——
# 不能凭空给每个发言的人都建一条印象（那是"用户画像"，不是"她的印象"）。
# 注意锚点在两处（appendSocialV2Message 与 appendSocialV2Poke），两处都要打：
# 拍一拍也是互动，漏掉会让人以为"只有说话才算"。
OLD_PUSH = """    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);"""
NEW_PUSH = """    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // MARKER: fix2bugs
    // 互动计数：这个人**已经在她印象里**，才算一次互动。
    // 不新建印象——凭空给每个发言的人都记一条，那是用户画像，不是她的印象。
    try {
      const im = st.memberImpressions && st.memberImpressions[sender];
      if (im && typeof im === 'object') {
        im.interactionCount = (Number(im.interactionCount) || 0) + 1;
        im.lastSeenAt = Date.now();
      }
    } catch {}"""

if src.count(OLD_PUSH) != 2:
    print(f'[x] 锚点「互动计数自增」匹配 {src.count(OLD_PUSH)} 次（预期 2：消息 + 拍一拍）')
    raise SystemExit(1)
src = src.replace(OLD_PUSH, NEW_PUSH)
print('  [ok] 互动计数已接到「消息」与「拍一拍」两处')

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{BRIDGE}.bak-fix2bugs-{stamp}'
shutil.copy2(BRIDGE, bak)
with open(BRIDGE + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(BRIDGE + '.tmp', BRIDGE)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  MARKER: {src.count(MARKER)} 处（预期 3）')
print('  复查：')
print(f'    save 有 lastImpressionRefreshAt: {src.count("lastImpressionRefreshAt: Number(st.lastImpressionRefreshAt)")}')
print(f'    load 默认 0: {src.count("Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : 0")}')
print(f'    补偿扫描: {src.count("补偿扫描补入")}')
