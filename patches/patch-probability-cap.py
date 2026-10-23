#!/usr/bin/env python3
"""唤醒概率降频三件（A 清存量 / B 服务端封顶 / C 文案讲清语义）。

## 为什么改：p=0.05 被当成「每小时 5%」在用，实际是「每条消息 5%」

`evaluateWakeTriggerV2` 最后一行：
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';

这是**对每条进入 `handleIncoming` 的群消息**掷一次骰子，不是按时间。实测
`group:906710082` 一小时缓冲上百条消息，0.05 的期望就是每小时多醒 5 次。所以在群里
「把概率设成 0.05」≈「每小时随缘醒 5 次」，和「5% 的运气」直觉完全不是一回事。

同理，AI 自己通过 `qq_set_wake_config` 写下的值也没有任何上限约束 ——
`state/social-v2.json` 里出现过 0.6（`private:3414115838`）、0.15、0.1 这些值。

## 三个洞 & 对应修法

- **A 存量脏值**：`state/social-v2.json` 里已有的超限值。本脚本按 group/private 分别收敛，
  先备份原文件。
- **B 未来写入**：`setWakeConfig` 的归一化只做 0~1 的上下界，没有群聊/私聊差异。
  新增 `clampWakeProbabilityV2()`，在**三个入口**都夹一次：
    1. `POST /api/socialV2/wake-config` 归一化段（AI 每次 set_wake_config 都过这里）
    2. `loadSocialV2State()` 每个会话加载后（防旧文件复活）
    3. `getSocialV2State()` 新建会话分支（防新群一上来就是 recommendedProbability）
- **C 文案误导**：MCP 工具描述只写「普通消息按该概率随机唤醒（0~1）」，没说是**每条消息**、
  也没说私聊根本不看这个值。改成讲清语义与量级，让 AI 自己就能权衡。

## 上限取多少

群聊 0.01：一小时上百条消息时约等于「每小时最多多醒 1 次」，符合「潜水但偶尔冒泡」。
私聊 0.1：仅防脏值 —— `evaluateWakeTriggerV2` 第一行 `if (kind === 'private') return 'private';`
就早退了，私聊本来就每条消息都唤醒，probability 对私聊**没有任何实际作用**。

两个上限都可从 `cfg.socialV2.wake.maxProbabilityInGroup` /
`maxProbabilityPrivate` 覆盖，缺省用上面的值。
"""
import json
import pathlib
import shutil
import sys
import time

BRIDGE = pathlib.Path('/opt/qq-bridge/src/bridge.js')
MCP = pathlib.Path('/opt/qq-bridge/src/mcp-snowluma-safe.js')
CONFIG = pathlib.Path('/opt/qq-bridge/config.json')
STATE = pathlib.Path('/opt/qq-bridge/state/social-v2.json')

HELPER = '''  // MARKER: probability-cap
  // probability 是「每条消息」的随机命中率，不是「每小时次数」。群里一小时上百条消息时，
  // 0.05 的期望就是每小时多醒 5 次 —— 这正是「一天醒上百次」的主要来源。
  // 上限只对群聊收紧：私聊在 evaluateWakeTriggerV2 第一行就 `return 'private'`，
  // 本来就每条消息都唤醒，probability 对私聊无实际作用，留个宽松上限只为防脏值。
  function clampWakeProbabilityV2(key, wakeConfig) {
    if (!wakeConfig || !wakeConfig.triggers) return false;
    const isGroup = String(key ?? '').startsWith('group:');
    const raw = Number(wakeConfig.triggers.probability);
    if (!Number.isFinite(raw) || raw < 0) return false;
    const capRaw = Number(isGroup
      ? (cfg.socialV2?.wake?.maxProbabilityInGroup ?? 0.01)
      : (cfg.socialV2?.wake?.maxProbabilityPrivate ?? 0.1));
    const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : (isGroup ? 0.01 : 0.1);
    if (raw <= cap) return false;
    wakeConfig.triggers.probability = cap;
    return true;
  }

'''

ANCHOR_HELPER = '  function defaultWakeConfigV2() {'

OLD_CLAMP = '''          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }'''

NEW_CLAMP = '''          // 归一化概率 + 上限（MARKER: probability-cap）
          // 这里原来只做 0~1 的上下界，等于不设防：AI 写 0.6 就照 0.6 用。
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
            clampWakeProbabilityV2(key, next);
          }'''

ANCHOR_LOAD = '''          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);'''

NEW_LOAD = '''          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          // 旧状态文件里可能存着超限概率（0.6 / 0.15 / 0.1 …），加载时就收敛掉，防复活。
          clampWakeProbabilityV2(key, st.wakeConfig);'''

ANCHOR_NEW = '''      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);'''

NEW_NEW = '''      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      // 新会话的默认概率来自 recommendedProbability，同样要过封顶（新群的群聊上限）。
      clampWakeProbabilityV2(key, st.wakeConfig);
      scheduleProactiveCheckV2(key);'''

OLD_DESC = "probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')"
NEW_DESC = ("probability: z.number().optional().describe('每条普通消息的随机唤醒概率（0~1）——注意这是**逐条消息**掷骰子，不是每小时次数："
            "群里一小时上百条消息时，0.05 大约等于每小时多醒 5 次。群聊生效率封顶 0.01（约每小时 1 次），"
            "私聊本来就是每条消息都唤醒、此项对私聊无实际作用。想更安静就调小或设 0，但注意 if infinite 时必须留有其它触发条件。')")


def patch_bridge():
    text = BRIDGE.read_text(encoding='utf-8')
    if 'MARKER: probability-cap' in text:
        print('· bridge.js 已含 probability-cap，跳过')
        return True

    n = text.count(ANCHOR_HELPER)
    if n != 1:
        print(f'❌ defaultWakeConfigV2 锚点命中 {n} 次（应为 1）')
        return False
    text = text.replace(ANCHOR_HELPER, HELPER + ANCHOR_HELPER)

    for old, new, name in (
        (OLD_CLAMP, NEW_CLAMP, 'setWakeConfig 归一化段'),
        (ANCHOR_LOAD, NEW_LOAD, 'loadSocialV2State'),
        (ANCHOR_NEW, NEW_NEW, 'getSocialV2State 新建分支'),
    ):
        c = text.count(old)
        if c != 1:
            print(f'❌ {name} 锚点命中 {c} 次（应为 1）')
            return False
        text = text.replace(old, new)

    if text.count('clampWakeProbabilityV2') != 4:
        print(f'❌ clampWakeProbabilityV2 应出现 4 次（1 定义 + 3 调用），实际 {text.count("clampWakeProbabilityV2")} 次')
        return False
    BRIDGE.write_text(text, encoding='utf-8')
    print('✅ bridge.js：新增 clampWakeProbabilityV2 + 三处入口调用')
    return True


def patch_mcp():
    text = MCP.read_text(encoding='utf-8')
    if NEW_DESC in text:
        print('· mcp-snowluma-safe.js 描述已是新文案，跳过')
        return True
    c = text.count(OLD_DESC)
    if c != 1:
        print(f'❌ 工具描述锚点命中 {c} 次（应为 1）')
        return False
    MCP.write_text(text.replace(OLD_DESC, NEW_DESC), encoding='utf-8')
    print('✅ mcp-snowluma-safe.js：probability 描述讲清「逐条消息」与私聊无效')
    return True


def patch_config():
    raw = CONFIG.read_text(encoding='utf-8')
    cfg = json.loads(raw)
    wake = cfg['socialV2']['wake']
    stamp = time.strftime('%Y%m%d-%H%M%S')
    bak = CONFIG.with_name(f'config.json.bak-probcap-{stamp}')
    shutil.copy2(CONFIG, bak)

    changed = []
    if wake.get('recommendedProbability') != 0.01:
        changed.append(f"recommendedProbability {wake.get('recommendedProbability')} -> 0.01")
        wake['recommendedProbability'] = 0.01
    if wake.get('maxProbabilityInGroup') != 0.01:
        changed.append('maxProbabilityInGroup -> 0.01')
        wake['maxProbabilityInGroup'] = 0.01
    if wake.get('maxProbabilityPrivate') != 0.1:
        changed.append('maxProbabilityPrivate -> 0.1')
        wake['maxProbabilityPrivate'] = 0.1

    if not changed:
        print('· config.json 无需改动')
        return True
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'✅ config.json：{"; ".join(changed)}（备份 {bak.name}）')
    return True


def patch_state():
    if not STATE.exists():
        print('· 无 state/social-v2.json，跳过')
        return True
    raw = STATE.read_text(encoding='utf-8')
    data = json.loads(raw)
    convs = data.get('conversations') or {}
    caps = {'group': 0.01, 'private': 0.1}
    rows = []
    for key, val in convs.items():
        if not isinstance(val, dict):
            continue
        tr = ((val.get('wakeConfig') or {}).get('triggers') or {})
        if 'probability' not in tr:
            continue
        try:
            cur = float(tr['probability'])
        except (TypeError, ValueError):
            continue
        cap = caps['group'] if key.startswith('group:') else caps['private']
        if cur > cap:
            tr['probability'] = cap
            rows.append((key, cur, cap))
    if not rows:
        print('· state 里没有超限概率')
        return True
    stamp = time.strftime('%Y%m%d-%H%M%S')
    bak = STATE.with_name(f'social-v2.json.bak-probcap-{stamp}')
    shutil.copy2(STATE, bak)
    STATE.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'✅ state/social-v2.json：收敛 {len(rows)} 个会话（备份 {bak.name}）')
    for key, cur, cap in rows:
        print(f'   {key:24} {cur} -> {cap}')
    return True


def main():
    ok = True
    for fn in (patch_bridge, patch_mcp, patch_config, patch_state):
        if not fn():
            ok = False
    if not ok:
        print('❌ 有步骤失败，检查后再重启桥接')
        return 1
    print('全部完成。重启桥接后生效。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
