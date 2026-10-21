"""修复：agent 内部错误原文被发进群里。

══ 问题（实测）══════════════════════════════════════════════════════════════

`src/bridge.js` 的 agent error 分支（约 11523 行）：

    await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);

`key` 是**当前会话**的 key。群聊就是 `group:906710082`，
于是内部错误原文直接落进群里。

实测 2026-10-21 08:02–08:07 连发 5 次：
    [08:02:26] group:906710082 agent 处理出错：buddy: 请求被拦截，
               请重新发送 Illegal API invocation from an unapproved channel

这既是**信息泄露**（把上游渠道名、内部报错路径暴露给群友），
也是**体验污染**（群友看到的是一条英文报错）。

══ 改法 ═══════════════════════════════════════════════════════════════════

1. **群聊**：只 log + appendActivity，**绝不 sendToQQ**。
2. **管理员私聊**：把诊断信息发到 `private:${cfg.ownerQQ}`。
   - 内容继续走 `redactKnownTokensOnly`（sendToQQ 内部已经做了一次）
     与 `SENSITIVE_RE` 双重把关，并且**截断**。
   - sendToQQ 自带 .catch，发送失败只会记日志，**不会抛错**，
     所以不存在「发私聊失败 → 又触发 error 分支 → 再发」的递归。
3. **未配置 ownerQQ**：只记日志，明确提示管理员去配置，不发任何会话。
4. **私聊会话本身出错**：仍然发给该私聊（因为他就是管理员本人），
   但不再额外抄送一份，避免重复。

══ 为什么要给管理员发 ═══════════════════════════════════════════════════════

`switch-provider.sh` 靠**日志行数**统计失败（用 grep 关键词），
所以 `log()` 这一行必须保留 —— 否则自动兜底永远看不到失败（这是早期就踩过的坑，
见交接文档里「配套改动：bridge.js 的 agent 错误分支现在会 log()」）。

回滚：
  cp src/bridge.js.bak-errpriv-<stamp> src/bridge.js
  systemctl restart qq-bridge
"""
import os
import shutil
import time

P = os.environ.get('QQ_BRIDGE_SRC') or '/opt/qq-bridge/src/bridge.js'
MARKER = 'MARKER: err-private-only'

src = open(P, encoding='utf-8', newline='').read()
if MARKER in src:
    print('[skip] 已打过')
    raise SystemExit(0)

OLD = """              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 必须同时进 stdout：switch-provider.sh 用日志行数水位线统计失败，
                // 只发 QQ 的话它在日志里什么都看不到，自动切换永远不会触发。
                log(`agent 处理出错 (${key}): ${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 200)}`);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
"""

NEW = """              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 必须同时进 stdout：switch-provider.sh 靠日志关键词统计失败，
                // 只发 QQ 的话它在日志里什么都看不到，自动兜底永远不会触发。
                log(`agent 处理出错 (${key}): ${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 200)}`);
                // MARKER: err-private-only
                // ⚠️ 2026-10-21 修复：这里原来是无条件 `sendToQQ(key, ...)`，
                // 群聊会话时会把内部错误原文直接发进群（实测 08:02–08:07 连发 5 次
                // "buddy: 请求被拦截…Illegal API invocation from an unapproved channel"）。
                // 那既泄露上游渠道与内部报错路径，也让群友看到一条英文报错。
                //
                // 现在：群聊只记日志；诊断信息只发给管理员私聊。
                // 注意 sendToQQ 内部自带 .catch（只记日志、不抛错），
                // 所以「发私聊失败」不会反向触发本分支，不存在递归。
                try {
                  const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
                  if (!ownerKey) {
                    log('⚠️ 未配置 ownerQQ：agent 错误无法发送给管理员，仅记录日志');
                  } else if (key === ownerKey) {
                    // 私聊本身就是管理员：照常发给他，但不重复抄送
                    await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                  } else {
                    // 群聊或他人私聊：只把诊断发给管理员，当前会话一个字都不发
                    await sendToQQ(ownerKey, `⚠️ agent 处理出错（${key}）：${safeMsg}`);
                  }
                } catch (notifyError) {
                  // 双保险：即使 notify 内部抛错，也绝不能让它污染主流程
                  log(`agent 错误通知发送失败（已忽略）：${notifyError?.message ?? notifyError}`);
                }
"""

if src.count(OLD) != 1:
    print(f'[x] 锚点匹配 {src.count(OLD)} 次（预期 1）')
    raise SystemExit(1)

src = src.replace(OLD, NEW, 1)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-errpriv-{stamp}'
shutil.copy2(P, bak)
with open(P + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(P + '.tmp', P)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  MARKER: {src.count(MARKER)} 处（预期 1）')
print(f'  群聊不再 sendToQQ(key: {src.count("await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`)")} 处（预期 1，仅私聊分支保留）')
