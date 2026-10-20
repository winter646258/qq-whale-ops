#!/usr/bin/env python3
"""把 aigengtu.com 的大肥鱼表情包全量导入 qq-bridge 表情库。

数据源：https://aigengtu.com/gallery-index.json（2141 张，含分类/台词/双语梗科普/预览直链）

设计要点：
- id 用 `aige-<编号>`，与已有 `mfuns-*` 不冲突
- desc 取图库台词（会参与 qq_list_stickers 关键词过滤，也是注入 prompt 的标签）
- localNote 从图库中文梗科普里压出「什么时候用」的一句话
- tags 带分类 + 归属标记，方便 AI 按关键词过滤
- source 固定 'manual'：mergeStickerLibrary 只清理 source='qq' 且不在 QQ 收藏里的条目，
  manual 的会永久保留
- url 用 0_preview 压缩图（实测 7~72 KB，远低于单条 4 MiB 上限）
- 只增不改：已存在的 id 一律跳过，不覆盖 AI 自己学到的 localNote/tags/useCount
"""
import json
import os
import re
import sys
import time

GALLERY = '/tmp/gallery-index.json'
STORE = '/opt/qq-bridge/state/stickers.json'
ID_PREFIX = 'aige-'
NOW = time.strftime('%Y-%m-%dT%H:%M:%S.000000Z', time.gmtime())

CATEGORY_TAGS = {
    'DeepSeek娘': ['deepseek', '鲸鱼娘', '大肥鱼'],
    'AI娘化': ['AI娘', '拟人'],
    'Claude娘': ['claude', 'AI娘'],
    'GPT娘': ['gpt', 'AI娘'],
    '豆大妈': ['豆包', 'AI'],
    'Kimi娘': ['kimi', 'AI娘'],
    '通义千问娘': ['通义千问', 'AI娘'],
    '智谱清言娘': ['智谱', 'AI娘'],
    'Gemini娘': ['gemini', 'AI娘'],
    'Grok娘': ['grok', 'AI娘'],
    'Stepfun娘': ['阶跃', 'AI娘'],
    'MiMo娘': ['mimo', 'AI娘'],
}

# 优先挑「适用的场景」那句，它最能指导选择
USE_PATTERNS = [
    re.compile(r'适用于([^。；;]{4,120})'),
    re.compile(r'常用(?:于)?([^。；;]{4,120})'),
    re.compile(r'多用于([^。；;]{4,120})'),
]


def usage_hint(story_zh: str) -> str:
    """从中文梗科普里压出一句「什么时候用」，压不出来就返回空。"""
    if not story_zh:
        return ''
    text = re.sub(r'\s+', ' ', story_zh)
    for pat in USE_PATTERNS:
        m = pat.search(text)
        if m:
            frag = m.group(1).strip(' ，,、')
            return f'适用：{frag}'[:200]
    first = re.split(r'[。；;]', text)[0].strip()
    return first[:120] if len(first) >= 8 else ''


def describe_less(s):
    """判断一条 desc 是否「没有信息量」。

    实测图库里有三类伪描述（合计 784 张，占 36%）：
      · 纯数字  形如 `DeepSeek娘『1000382674』表情包`（数字是图库 ID，不是描述）
      · 哈希    形如 `DeepSeek娘『efb578638535e5dd…』表情包`
      · 无括号  形如 `AI娘表情包`（只有分类名）
    这类描述会浪费注入 prompt 的候选池名额，也可能让 AI 瞎发。

    判定顺序与 bridge 侧 `buildStickerContext` 的 `describeLess()` 保持一致
    （先去哈希、再去长数字），否则两边对「干净」的定义会漂移。
    """
    raw = str(s or '').strip()
    if not raw:
        return True
    st = re.sub(r'[0-9a-f]{8,}', '', raw, flags=re.I)
    st = re.sub(r'[0-9]{4,}', '', st)
    st = re.sub(r'[『』【】<>《》()（）\[\]]', '', st)
    st = re.sub(r'表情包|表情|DeepSeek娘|DeepSeek|deepseek', '', st, flags=re.I).strip()
    return len(re.findall(r'[\u4e00-\u9fa5]', st)) < 2


def load_gallery():
    with open(GALLERY, encoding='utf-8') as f:
        return json.load(f)['gallery']


def build_entries(gallery):
    out = []
    for cat, block in gallery.items():
        extra = CATEGORY_TAGS.get(cat, [])
        for img in (block.get('images') or []):
            preview = str(img.get('preview') or '').strip()
            original = str(img.get('original') or '').strip()
            if not preview.startswith('https://'):
                continue
            num = ''
            for src in (preview, original):
                part = src.rsplit('/', 1)[-1]
                if part.endswith('.webp'):
                    num = part[:-5]
                    break
            if not num:
                continue
            alt = str(img.get('alt') or img.get('name') or '').strip()
            story = img.get('story') or {}
            note = usage_hint(story.get('zh') or '')
            # desc 质量兜底：图库给的 alt 若是伪描述（纯数字/哈希/只有分类名），
            # 优先用梗科普的中文开头当描述，再退到「分类#编号」，最后才保留原 alt。
            # 目的是让注入 prompt 的候选池里不出现 `DeepSeek娘『1000382674』` 这种乱码。
            desc = alt
            if describe_less(alt):
                fb = ''
                if note:
                    fb = note.replace('适用：', '').strip()
                if fb and not describe_less(fb):
                    desc = f'{cat}｜{fb[:60]}'
                else:
                    desc = f'{cat}表情包#{num}'
            out.append({
                'id': f'{ID_PREFIX}{num}',
                'resId': f'{ID_PREFIX}{num}',
                'url': preview,
                'md5': '',
                'desc': desc,
                'localNote': note,
                'tags': [cat] + extra,
                'usage': '',
                'source': 'manual',
                'useCount': 0,
                'lastUsedAt': 0,
                'lastContext': '',
                'createdAt': NOW,
                'updatedAt': NOW,
            })
    return out


def main():
    dry = '--dry-run' in sys.argv
    limit = None
    for a in sys.argv:
        if a.startswith('--limit='):
            limit = int(a.split('=', 1)[1])

    gallery = load_gallery()
    candidates = build_entries(gallery)
    with_hint = sum(1 for c in candidates if c['localNote'])
    print(f'图库候选: {len(candidates)} 张（{len(gallery)} 个分类，其中 {with_hint} 张带「适用」提示）')

    with open(STORE, encoding='utf-8') as f:
        store = json.load(f)
    existing_ids = {str(e.get('id')) for e in store}
    fresh = [c for c in candidates if c['id'] not in existing_ids]
    print(f'现有库: {len(store)} 条 | 待新增: {len(fresh)} 条（已存在跳过 {len(candidates) - len(fresh)}）')

    if limit:
        fresh = fresh[:limit]
        print(f'按 --limit 截取: {len(fresh)} 条')

    if dry:
        for e in fresh[:4]:
            print('  样例:', json.dumps(e, ensure_ascii=False)[:300])
        print('（--dry-run，不写盘）')
        return

    if not fresh:
        print('没有需要新增的条目')
        return

    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = f'{STORE}.bak.{stamp}'
    with open(backup, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False, indent=2)
    print(f'已备份: {backup}')

    merged = store + fresh
    tmp = f'{STORE}.import.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STORE)
    print(f'写入完成: {len(merged)} 条（新增 {len(fresh)}）')

    from collections import Counter
    print('新增分类分布:', dict(Counter(e['tags'][0] for e in fresh)))


if __name__ == '__main__':
    main()
