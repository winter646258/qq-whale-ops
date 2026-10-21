#!/bin/bash
# 第 6 项生产验证：重启后主动档期是否「续档」而不是重抽
set -u
SRC=/opt/qq-bridge
snap() {
python3 - "$SRC/state/social-v2.json" <<'PY'
import json,sys,time
d=json.load(open(sys.argv[1]))
convs=d.get('conversations',d)
now=int(time.time()*1000)
for k,v in convs.items():
    if not isinstance(v,dict): continue
    n=int(v.get('proactiveNextAt') or 0)
    if n>now:
        print(k, 'remain_min=%.1f' % ((n-now)/60000))
PY
}
echo "=== 重启前 ==="
snap | tee /tmp/before.txt

echo "=== 重启 ==="
systemctl restart qq-bridge
for i in $(seq 1 20); do sleep 2; [ "$(systemctl is-active qq-bridge)" = active ] && break; done
sleep 8
echo "状态: $(systemctl is-active qq-bridge)"

echo "=== 重启后 ==="
snap | tee /tmp/after.txt

echo "=== 对比（差得少=续档成功；差很多=又被重抽）==="
python3 - <<'PY'
import re
def load(p):
    r={}
    for line in open(p):
        line=line.strip()
        if not line: continue
        k,v=line.split(' remain_min='); r[k]=float(v)
    return r
b=load('/tmp/before.txt'); a=load('/tmp/after.txt')
for k,v in b.items():
    if k in a:
        diff=v-a[k]
        verdict='续档 OK' if abs(diff)<3 else '⚠️ 被重抽'
        print(f'  {k}: 前 {v:.1f}min → 后 {a[k]:.1f}min（差 {diff:+.1f}） {verdict}')
    else:
        print(f'  {k}: 重启后没有未来档期了 ⚠️')
PY

echo "=== 重启后的排档日志 ==="
tail -120 "$SRC/state/bridge.log" | grep -E '已安排主动机会检查|读取 socialV2 状态失败|before initialization' || echo "(无)"
echo "=== 实例/锁 ==="
echo "PPID=1 实例: $(pgrep -f 'node src/bridge.js' | while read p; do [ "$(awk '{print $4}' /proc/$p/stat 2>/dev/null)" = 1 ] && echo x; done | wc -l)"
