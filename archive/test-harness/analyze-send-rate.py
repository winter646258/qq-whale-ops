"""分析当前实际发送节奏，判断 6/40 是否仍不够。"""
import json
import time
from collections import Counter

d = json.load(open('/opt/qq-bridge/state/social-v2.json', encoding='utf-8'))
st = (d.get('conversations') or {}).get('group:910502749') or {}
times = sorted(int(t) for t in (st.get('sendTimes') or []) if t)
print(f'发送时间戳: {len(times)} 条')
if not times:
    raise SystemExit(0)
print(f'跨度: {time.strftime("%H:%M:%S", time.localtime(times[0]/1000))} ~ '
      f'{time.strftime("%H:%M:%S", time.localtime(times[-1]/1000))}')

now = int(time.time() * 1000)
win1 = [t for t in times if now - t < 60_000]
win5 = [t for t in times if now - t < 300_000]
win60 = [t for t in times if now - t < 3600_000]
print(f'\n当前滚动窗口:')
print(f'  近 1 分钟 : {len(win1)} 条 (上限 6)')
print(f'  近 5 分钟 : {len(win5)} 条')
print(f'  近 1 小时 : {len(win60)} 条 (上限 40)')

def peak(span):
    return max((sum(1 for t in times if 0 <= t - times[i] < span) for i in range(len(times))), default=0)

print(f'\n历史峰值:')
p1, p5, p60 = peak(60_000), peak(300_000), peak(3600_000)
print(f'  任意 1 分钟 : {p1} 条')
print(f'  任意 5 分钟 : {p5} 条')
print(f'  任意 1 小时 : {p60} 条')

per_min = Counter(time.strftime('%H:%M', time.localtime(t/1000)) for t in times)
print(f'\n每分钟 TOP 8:')
for k, v in per_min.most_common(8):
    print(f'  {k}  {v} 条')

per_hour = Counter(time.strftime('%H', time.localtime(t/1000)) for t in times)
print(f'\n每小时:')
for k, v in sorted(per_hour.items()):
    print(f'  {k} 时  {v} 条')

# 建议：按峰值 + 余量
print(f'\n建议:')
print(f'  分钟: 峰值 {p1} + 3 余量 → {max(8, p1 + 3)}')
print(f'  小时: 峰值 {p60} + 15 余量 → {max(50, p60 + 15)}')
print(f'  （对照私聊 8/60）')
