"""对比群/私聊的「回合结构」，找出表情被挤掉的原因。

思路：把调用按时间聚成回合（间隔 > 60s 视为新回合），统计每回合的
      工具序列、文本条数、等待次数、有无表情。
"""
import json
import time
from collections import Counter, defaultdict

rows = []
with open('/opt/qq-bridge/state/tool-calls.jsonl', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass

calls = [r for r in rows if r.get('type') == 'call' and r.get('time')]
calls.sort(key=lambda r: r['time'])


def parse_ms(t):
    try:
        return time.mktime(time.strptime(t[:19], '%Y-%m-%dT%H:%M:%S'))
    except Exception:
        return 0.0


def turns_for(key_pred):
    seq = [r for r in calls if key_pred(r.get('key') or '')]
    turns = []
    cur = []
    prev = None
    for r in seq:
        t = parse_ms(r['time'])
        if prev is not None and t - prev > 60:
            if cur:
                turns.append(cur)
            cur = []
        cur.append(r)
        prev = t
    if cur:
        turns.append(cur)
    return turns


def summarize(label, turns):
    turns = list(turns)
    print(f'=== {label}: {len(turns)} 个回合 ===')
    n_wait = n_send = n_sticker = 0
    text_counts = []
    for tn in turns:
        tools = [r.get('tool', '').replace('mcp__snowluma__', '') for r in tn]
        if any('sticker' in x for x in tools):
            n_sticker += 1
        waits = sum(1 for x in tools if 'wait_for_messages' in x)
        n_wait += waits
        sends = [r for r in tn if 'send_message' in (r.get('tool') or '')
                 or 'send_burst' in (r.get('tool') or '')]
        n_send += len(sends)
        # 数本次回合发了多少条文本
        for r in sends:
            a = r.get('args')
            if isinstance(a, str):
                try:
                    a = json.loads(a)
                except Exception:
                    a = {}
            m = (a or {}).get('messages')
            if isinstance(m, list):
                text_counts.append(len(m))
            elif isinstance(m, str):
                try:
                    p = json.loads(m)
                    text_counts.append(len(p) if isinstance(p, list) else 1)
                except Exception:
                    text_counts.append(1)
    print(f'  含表情的回合        : {n_sticker} / {len(turns)}  ({n_sticker*100//max(1,len(turns))}%)')
    print(f'  wait_for_messages   : {n_wait} 次  (平均每回合 {n_wait/max(1,len(turns)):.1f})')
    print(f'  send_message 调用   : {n_send} 次')
    if text_counts:
        print(f'  每次发送的文本条数  : 平均 {sum(text_counts)/len(text_counts):.1f}，最多 {max(text_counts)}')
    # 单回合工具数分布
    sizes = Counter(len(tn) for tn in turns)
    print(f'  每回合工具调用数分布: {dict(sorted(sizes.items()))}')
    print()


summarize('群聊 group:910502749', lambda k: k.startswith('group:'))
summarize('私聊 private:*', lambda k: k.startswith('private:'))
