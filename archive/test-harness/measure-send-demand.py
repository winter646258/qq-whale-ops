"""量化真实发送需求 = 成功条数 + 被拦条数（按小时）。"""
import json
import time
from collections import Counter

# ① 成功发送时间戳
d = json.load(open('/opt/qq-bridge/state/social-v2.json', encoding='utf-8'))
st = (d.get('conversations') or {}).get('group:910502749') or {}
sent = sorted(int(t) for t in (st.get('sendTimes') or []) if t)

# ② 被拦的条数（从 tool-calls 统计 failed send_message 的 messages 条数）
blocked = []
with open('/opt/qq-bridge/state/tool-calls.jsonl', encoding='utf-8') as f:
    rows = [json.loads(l) for l in f if l.strip()]
for r in rows:
    if 'group:910502749' not in json.dumps(r, ensure_ascii=False):
        continue
    if r.get('type') != 'result' or r.get('ok') is not False:
        continue
    if 'send_message' not in str(r.get('tool')):
        continue
    # 找配对的 call 取条数
    blocked.append(r.get('time'))

print(f'成功发送: {len(sent)} 条')
print(f'被拦次数: {len(blocked)} 次')

# 从 calls 里数被拦时想发几条
want = 0
for r in rows:
    if r.get('type') != 'call' or 'group:910502749' not in json.dumps(r, ensure_ascii=False):
        continue
    if 'send_message' not in str(r.get('tool')):
        continue
    t = (r.get('time') or '')
    # 该 call 之后 3 秒内有失败 result 视为被拦
    for b in blocked:
        if b and t and 0 <= (time.mktime(time.strptime(b[:19], '%Y-%m-%dT%H:%M:%S')) -
                             time.mktime(time.strptime(t[:19], '%Y-%m-%dT%H:%M:%S'))) <= 3:
            a = r.get('args')
            if isinstance(a, str):
                try: a = json.loads(a)
                except: a = {}
            m = (a or {}).get('messages')
            if isinstance(m, list): want += len(m)
            elif isinstance(m, str):
                try:
                    p = json.loads(m)
                    want += len(p) if isinstance(p, list) else 1
                except: want += 0
            break

print(f'被拦时想发的条数（估）: {want} 条')
print()
print(f'真实需求 ≈ {len(sent)} + {want} = {len(sent) + want} 条/小时')

# 按小时看成功数
per_hour = Counter(time.strftime('%H', time.localtime(t/1000)) for t in sent)
print()
print('成功发送按小时:')
for k, v in sorted(per_hour.items()):
    print(f'  {k} 时  {v} 条')

# 分钟峰值
def peak(span):
    return max((sum(1 for t in sent if 0 <= t - sent[i] < span) for i in range(len(sent))), default=0)
print()
print(f'分钟峰值: 1分 {peak(60000)} | 5分 {peak(300000)}')
print()
print('=== 建议 ===')
demand = len(sent) + want
print(f'  小时: 需求 {demand} + 余量 15 → {demand + 15}')
print(f'  分钟: 峰值 {peak(60000)} + 余量 4 → {max(8, peak(60000) + 4)}')
print(f'  对照：私聊 8/60；当前群聊 6/40（不够）')
