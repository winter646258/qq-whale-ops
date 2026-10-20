"""让「agent 处理出错」也写进 stdout，好让 switch-provider.sh 的水位线能看见。

背景（2026-10-19）：CodeBuddy 全部账号被限流时，桥接只把
「⚠️ agent 处理出错：…可用账号均在限流中…」发到 QQ 会话，
stdout / bridge.log / qq-activity.log / feedback.json 里全都没有记录。
结果是 switch-provider.sh 的水位线永远统计不到失败，自动切换形同虚设。
"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

old = """              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);"""

new = """              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 必须同时进 stdout：switch-provider.sh 用日志行数水位线统计失败，
                // 只发 QQ 的话它在日志里什么都看不到，自动切换永远不会触发。
                log(`agent 处理出错 (${key}): ${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 200)}`);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);"""

assert src.count(old) == 1, f'匹配数异常: {src.count(old)}'
src = src.replace(old, new)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak.{stamp}'
shutil.copy2(P, bak)
tmp = P + '.tmp'
open(tmp, 'w', encoding='utf-8').write(src)
os.replace(tmp, P)
print('备份:', bak)
print('新增行确认 log():', src.count("log(`agent 处理出错 (${key}): ${safeMsg}`);"))
print('新增行确认 appendActivity():', src.count('agent 处理出错：${safeMsg.slice(0, 200)}'))
