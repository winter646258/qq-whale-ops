#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""让二代模式允许人格卡/发送内容里的中文空格。

背景：v1 用空格分条，v2 走工具数组，空格只是普通字符。群里 44% 的人用空格断句，
所以不再把示例改写成逗号，也不再给 AI 发「真人一般不这么打」的软提醒。
由 socialV2.role.allowCjkSpaces 控制，默认 true；设 false 可恢复旧行为。
"""
import sys

PATH = '/opt/qq-bridge/src/bridge.js'

old_sig = "function roleWarnings(content, mode = 'v2') {"
new_sig = "function roleWarnings(content, mode = 'v2', allowCjkSpaces = true) {"

old_warn = """  if (/回复示例/.test(untagged) && /[\\u4e00-\\u9fff]\\s+[\\u4e00-\\u9fff]/.test(untagged)) {
    warnings.push('\u201c回复示例\u201d节里的中文空格会被自动改写成逗号（二代不用空格分条），建议直接写逗号，或把该节标记为 〔一代〕');
  }"""
new_warn = """  // 二代已改用工具数组分条，示例里的中文空格只是普通字符；只有显式关掉
  // socialV2.role.allowCjkSpaces 时才会被改写成逗号，这时才值得提醒。
  if (!allowCjkSpaces && /回复示例/.test(untagged) && /[\\u4e00-\\u9fff]\\s+[\\u4e00-\\u9fff]/.test(untagged)) {
    warnings.push('\u201c回复示例\u201d节里的中文空格会被自动改写成逗号（已设 role.allowCjkSpaces=false），建议直接写逗号，或把该节标记为 〔一代〕');
  }"""

old_hint_head = """  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';"""
new_hint_head = """  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代靠「中文空格」分条，二代靠工具数组分条，空格在二代只是普通字符。
    // 默认保留（群里本来就有人用空格断句），设 false 才回退到「改写成逗号」的老行为。
    const allowCjkSpaces = cfg.socialV2?.role?.allowCjkSpaces !== false;"""

old_title = """        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));"""
new_title = """        kept.push(line.replace(/（空格代表前后分两条消息回答）/, allowCjkSpaces
          ? '（示例中用空格表示停顿；要分多条请把数组写成多个元素）'
          : '（示例中已用逗号表示停顿；想分多条请用数组）'));"""

old_conv = """      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));"""
new_conv = """      if (inExampleSection) {
        kept.push(allowCjkSpaces ? line : convertExampleSpacesToComma(line));"""

old_scan = """  function findCjkSpaceWarning(messages) {
    const bad = [];"""
new_scan = """  function findCjkSpaceWarning(messages) {
    // 二代靠工具数组分条，单条消息里的中文空格是群聊里常见的停顿写法（实测群友 44% 这么打），
    // 不再是「该拆成多条」的信号。默认不再提示，免得和人格卡里的「用空格断句」互相打脸。
    if (cfg.socialV2?.role?.allowCjkSpaces !== false) return null;
    const bad = [];"""

old_c1 = "            warnings: roleWarnings(content),"
new_c1 = "            warnings: roleWarnings(content, 'v2', cfg.socialV2?.role?.allowCjkSpaces !== false),"

old_c2 = "          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });"
new_c2 = "          sendJson({ ok: true, role: name, warnings: roleWarnings(content, 'v2', cfg.socialV2?.role?.allowCjkSpaces !== false) });"

old_c3 = "          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });"
new_c3 = "          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content, 'v2', cfg.socialV2?.role?.allowCjkSpaces !== false) });"

EDITS = [
    ('roleWarnings 签名', old_sig, new_sig, 1),
    ('roleWarnings 提示条件', old_warn, new_warn, 1),
    ('currentRoleHintV2 读开关', old_hint_head, new_hint_head, 1),
    ('示例标题改写', old_title, new_title, 1),
    ('示例空格转换', old_conv, new_conv, 1),
    ('findCjkSpaceWarning 早退', old_scan, new_scan, 1),
    ('调用点 1', old_c1, new_c1, 1),
    ('调用点 2', old_c2, new_c2, 1),
    ('调用点 3', old_c3, new_c3, 1),
]

with open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

orig = src
failed = []
for name, old, new, expect in EDITS:
    n = src.count(old)
    if n != expect:
        failed.append(f'{name}: 期望 {expect} 处，实际 {n} 处')
        continue
    src = src.replace(old, new, expect)
    print(f'OK  {name}')

if failed:
    print('\n=== 未改动，失败项 ===')
    for f_ in failed:
        print('  ' + f_)
    sys.exit(1)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print(f'\n已写入 {PATH}：{len(orig)} -> {len(src)} 字节（+{len(src)-len(orig)}）')
