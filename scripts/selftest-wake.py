import json
import time
import urllib.request

CONSOLE = open('/opt/qq-bridge/state/console-token', encoding='utf-8').read().strip()
sv = json.load(open('/opt/qq-bridge/state/social-v2.json', encoding='utf-8'))
KEY = 'private:1124721191'
agent = sv['conversations'][KEY]['agentToken']

HDR = {
    'x-console-token': CONSOLE,
    'x-agent-token': agent,
    'content-type': 'application/json',
}


def call(method, path, body=None, timeout=40):
    req = urllib.request.Request(
        'http://127.0.0.1:3100' + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers=HDR,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except Exception as e:
        raw = b''
        try:
            raw = e.read()
        except Exception:
            pass
        return {'_err': str(e), '_body': raw[:200].decode('utf-8', 'replace')}


print('1) 唤醒会话（让 AI 走一整轮：读上下文 → 调工具 → 说话）')
r = call('POST', '/api/socialV2/wake', {'key': KEY, 'reason': '自检'})
print('   wake ->', json.dumps(r, ensure_ascii=False)[:200])

print('2) 轮询最近消息，等 AI 的回复')
for i in range(10):
    time.sleep(12)
    r = call('GET', '/api/socialV2/recent?key=' + KEY + '&count=6')
    msgs = r.get('messages') or r.get('recent') or []
    tail = []
    for m in msgs[-4:]:
        who = 'AI' if m.get('isSelf') else '对方'
        txt = str(m.get('text') or m.get('plain') or '')[:70]
        tail.append(f'{who}: {txt}')
    print(f'   [{i*12+12}s] ' + ' | '.join(tail) if tail else f'   [{i*12+12}s] (无新消息) {json.dumps(r, ensure_ascii=False)[:150]}')
    if any('出错' in t for t in tail):
        print('   ⚠️ 仍报错')
        break
