import json
import re
import urllib.request

key = ''
try:
    t = open('/root/.dsh/.env', encoding='utf-8').read()
    m = re.search(r'DEEPSEEK_API_KEY\s*=\s*(\S+)', t)
    key = m.group(1) if m else ''
except Exception as e:
    print('读 key 失败:', e)

print('key 前缀:', (key[:8] + '...') if key else '(空)')
if not key:
    raise SystemExit(0)

body = json.dumps({
    'model': 'deepseek-chat',
    'messages': [{'role': 'user', 'content': 'ping'}],
    'max_tokens': 4,
}).encode()
req = urllib.request.Request(
    'https://api.deepseek.com/chat/completions',
    data=body,
    headers={'content-type': 'application/json', 'authorization': 'Bearer ' + key},
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    print('官方 API 可用 | model =', d.get('model'), '| 回复 =', (d.get('choices') or [{}])[0].get('message', {}).get('content'))
except Exception as e:
    raw = b''
    try:
        raw = e.read()
    except Exception:
        pass
    print('官方 API 失败:', e, '|', raw[:300].decode('utf-8', 'replace'))
