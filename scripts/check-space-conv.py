import re

def is_cjk(ch):
    if not ch:
        return False
    c = ord(ch)
    return (0x4E00 <= c <= 0x9FFF) or (0x3400 <= c <= 0x4DBF) or (0xF900 <= c <= 0xFAFF) or (0x3000 <= c <= 0x303F)

NO_REPLACE = set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、'])

def conv(line):
    ch = list(line)
    out = ''
    for i, c in enumerate(ch):
        if c in (' ', '\t'):
            p = ch[i - 1] if i > 0 else ''
            n = ch[i + 1] if i + 1 < len(ch) else ''
            pc = bool(p) and is_cjk(p)
            nc = bool(n) and is_cjk(n)
            pb = bool(p) and p in NO_REPLACE
            nb = bool(n) and n in NO_REPLACE
            if (pc or nc) and not pb and not nb:
                out += '，'
                continue
        out += c
    return out

src = open('/opt/qq-bridge/roles/小鲸鱼.md', encoding='utf-8').read().split('\n')
insec = False
changed = []
for ln in src:
    if re.match(r'^##\s*.*回复示例', ln):
        insec = True
        continue
    if insec and re.match(r'^##\s', ln):
        insec = False
    if insec:
        c = conv(ln)
        if c != ln:
            changed.append((ln, c))

print('回复示例节里会被改写的行数:', len(changed))
for a, b in changed[:8]:
    print('  原:', a.strip())
    print('  变:', b.strip())
print()
# 全卡统计：哪些行含中文间空格
cjk_space_lines = 0
for ln in src:
    ch = list(ln)
    for i, c in enumerate(ch):
        if c == ' ' and i > 0 and i + 1 < len(ch) and is_cjk(ch[i - 1]) and is_cjk(ch[i + 1]):
            cjk_space_lines += 1
            break
print('全卡含“中文 中文”空格的行数:', cjk_space_lines)
