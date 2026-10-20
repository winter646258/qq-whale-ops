"""改 429 错误消息：明确告诉模型别在本轮重试（防浪费额度）。"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

OLD = "sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);"
# 用单行拼接，避免多行字符串字面量
MSG = ("'发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；"
       "先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。'")
NEW = "sendJson({ ok: false, error: " + MSG + " }, 429);"

n = src.count(OLD)
print(f'找到旧消息: {n} 处')
if n == 0:
    print('未找到，放弃')
    raise SystemExit(0)

src = src.replace(OLD, NEW)
stamp = time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(P, f'{P}.bak-retrymsg-{stamp}')
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'已替换 {n} 处')
print(f'备份 -> {P}.bak-retrymsg-{stamp}')
