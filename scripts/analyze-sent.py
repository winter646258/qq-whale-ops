#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计她重启后发出的消息里，逗号/空格/长度/连发的实际变化。

用法：
  ssh alihz 'grep "\[send\]" /opt/qq-bridge/state/qq-activity.log' | python3 analyze.py
或直接传文件路径：python3 analyze.py /tmp/sent.txt

只在标准输入/文件里找形如：
  [19:15:07] group:201188739 [send] 成功 1/1 条：有，小鲸鱼，别叫大肥鱼就行
"""
import re
import sys
from collections import Counter

LINE_RE = re.compile(
    r'^\[(?P<hm>\d{2}:\d{2}(?::\d{2})?)\]\s+(?P<key>\S+)\s+\[send\]\s+成功\s+(?P<ok>\d+)/(?P<tot>\d+)\s+条：(?P<text>.*)$'
)

CJK = re.compile(r'[\u4e00-\u9fff]')


def load(lines):
    rows = []
    for raw in lines:
        line = raw.rstrip('\n')
        m = LINE_RE.match(line)
        if not m:
            continue
        text = m.group('text')
        rows.append({
            'hm': m.group('hm'),
            'key': m.group('key'),
            'text': text,
            'batch': (int(m.group('ok')), int(m.group('tot'))),
        })
    return rows


def cjk_space(text):
    """中文与中文之间的半角空格个数。"""
    return len(re.findall(r'[\u4e00-\u9fff]\s[\u4e00-\u9fff]', text))


def report(rows):
    if not rows:
        print('没有匹配到 send 记录。')
        return
    texts = [r['text'] for r in rows]
    n = len(texts)

    comma = sum('，' in t for t in texts)
    space = sum(cjk_space(t) > 0 for t in texts)
    q = sum(('？' in t or '?' in t) for t in texts)
    bang = sum(('！' in t or '!' in t) for t in texts)
    period = sum(('。' in t) for t in texts)

    # 「A，B / A B」对仗：中文逗号或中文间空格切出来的两段都 >=2 字
    dui = 0
    for t in texts:
        parts = [p for p in re.split(r'[，\s]', t) if len(CJK.findall(p)) >= 2]
        if len(parts) >= 2:
            dui += 1

    lens = sorted(len(t) for t in texts)
    short5 = sum(l <= 5 for l in lens)
    med = lens[len(lens) // 2] if lens else 0
    p90 = lens[int(len(lens) * 0.9) - 1] if lens else 0

    # 连发：同 key 且同分钟内的多条算一轮
    rounds = Counter((r['key'], r['hm'][:5]) for r in rows)
    burst_rounds = sum(1 for c in rounds.values() if c >= 2)

    def pct(a, b):
        return f'{a}/{b} = {a * 100.0 / b:.1f}%' if b else '-'

    print(f'样本：{n} 条（重启后）\n')
    print('指数                 实测      改版前基线      群友基线')
    print(f'含中文逗号           {pct(comma, n):<12} 88%            29%')
    print(f'含中文间空格         {pct(space, n):<12} 4%             44%')
    print(f'含问号               {pct(q, n):<12} 14%            7%')
    print(f'含感叹号             {pct(bang, n):<12} 0%             2%')
    print(f'含句号               {pct(period, n):<12} 0%             8%')
    print(f'像对仗（>=2 段各2字+） {pct(dui, n):<11} 61%            16%')
    print(f'<=5 字               {pct(short5, n):<12} 1.9%           14.6%')
    print(f'中位字数             {med:<12} 15             14')
    print(f'P90 字数             {p90:<12} 25             38')
    print(f'连发轮（同分钟>=2条）  {pct(burst_rounds, len(rounds)):<11} 3%             21%')
    print('\n--- 逐条 ---')
    for r in rows:
        flag = []
        if cjk_space(r['text']):
            flag.append(f"空格x{cjk_space(r['text'])}")
        if '，' in r['text']:
            flag.append('逗')
        print(f"{r['hm']} [{len(r['text']):>2}字] {' '.join(flag):<10} {r['text']}")


if __name__ == '__main__':
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding='utf-8') as f:
            lines = f.readlines()
    else:
        lines = sys.stdin
    report(load(lines))
