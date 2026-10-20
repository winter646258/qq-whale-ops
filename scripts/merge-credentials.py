"""精细合并 .credentials.yaml 的 refs 段。

原则（安全第一）：
  - 服务器已有的键一律**保持不动**（尤其 DEEPSEEK_API_KEY / 现有 BUDDY 账号）
  - 只把「本地有、服务器没有」的 refs 条目补进去
  - 合并前对服务器原文件做时间戳备份
"""
import shutil
import sys
import time

import yaml

SERVER = '/root/.dsh/.credentials.yaml'
LOCAL = '/tmp/ofm-creds/local-credentials.yaml'


def load(path):
    with open(path, encoding='utf-8') as fh:
        return yaml.safe_load(fh) or {}


server = load(SERVER)
local = load(LOCAL)

if server.get('version') != local.get('version'):
    print(f'⚠️ version 不同：server={server.get("version")} local={local.get("version")}')

s_refs = server.get('refs') or {}
l_refs = local.get('refs') or {}
s_recs = server.get('records') or {}
l_recs = local.get('records') or {}

print(f'refs：服务器 {len(s_refs)} 条 / 本地 {len(l_refs)} 条')
print(f'records：服务器 {len(s_recs)} 条 / 本地 {len(l_recs)} 条')

added, kept = [], []
for key, value in l_refs.items():
    if key in s_refs:
        kept.append(key)          # 服务器已有 ⇒ 不动
    else:
        s_refs[key] = value
        added.append(key)

added_rec, kept_rec = [], []
for key, value in l_recs.items():
    if key in s_recs:
        kept_rec.append(key)
    else:
        s_recs[key] = value
        added_rec.append(key)

server['refs'] = s_refs
server['records'] = s_recs

stamp = time.strftime('%Y%m%d-%H%M%S')
backup = f'{SERVER}.bak-{stamp}'
shutil.copy2(SERVER, backup)

with open(SERVER + '.tmp', 'w', encoding='utf-8') as fh:
    yaml.safe_dump(server, fh, allow_unicode=True, sort_keys=False, default_flow_style=False)
import os
os.chmod(SERVER + '.tmp', 0o600)
os.replace(SERVER + '.tmp', SERVER)

print(f'备份 -> {backup}')
print(f'新增 refs {len(added)} 条: {", ".join(added) if added else "（无）"}')
print(f'保留服务器原有 refs {len(kept)} 条: {", ".join(kept) if kept else "（无）"}')
print(f'新增 records {len(added_rec)} 条: {", ".join(added_rec) if added_rec else "（无）"}')
print(f'合并后 refs 共 {len(s_refs)} 条 / records 共 {len(s_recs)} 条')

# 回读校验：确认关键键仍在，且 YAML 可解析
check = load(SERVER)
assert 'DEEPSEEK_API_KEY' in (check.get('refs') or {}), 'DEEPSEEK_API_KEY 丢失！'
print('回读校验：DEEPSEEK_API_KEY 在位 ✅  解析正常 ✅')
