#!/bin/bash
echo "=== 进程树 ==="
ps -o pid,ppid,cmd -C node 2>/dev/null | grep bridge
echo
echo "=== systemd MainPID ==="
systemctl show qq-bridge -p MainPID --value
echo
echo "=== 服务 ==="
systemctl is-active qq-dsh qq-bridge qq-zone-watch qq-provider-switch
echo
echo "=== provider ==="
python3 -c "import json;print(json.load(open('/opt/qq-bridge/config.json'))['dsh']['provider'])"
echo
echo "=== 锁 ==="
cat /opt/qq-bridge/state/bridge.lock 2>/dev/null || echo "(无锁)"
echo
echo "=== 实例数（应只有 systemd 那一个）==="
pgrep -c -f "node src/bridge.js"
