import io
import ast
import sys

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'

SRC = io.open(TARGET, encoding='utf-8').read()

MARKER = '// MARKER: shared-memory-maxchars'

OLD = """    const maxChars = bounded('sharedMemoryMaxChars', SHARED_MEMORY_INJECT_MAX_CHARS, 200, 2000);"""

NEW = r"""    // MARKER: shared-memory-maxchars
    // 这里不能调 bounded() —— 它是 buildWakeSnapshotV2 内部的局部箭头函数
    // （同一份文件、但另一个作用域），模块层拿不到它，调了就是运行期
    // ReferenceError: bounded is not defined。而这一行是**每条唤醒 prompt 都会走**
    // 的路径，一旦抛错就是整条唤醒失败（2026-10-22 20:08:33 主人私聊唤醒即栽于此）。
    // 所以就地夹紧，读的还是同一个 cfg.socialV2.context，键名保持一致。
    const smContext = cfg.socialV2?.context ?? {};
    const smWant = Number(smContext.sharedMemoryMaxChars ?? SHARED_MEMORY_INJECT_MAX_CHARS);
    const maxChars = Number.isFinite(smWant)
      ? Math.min(2000, Math.max(200, Math.round(smWant)))
      : SHARED_MEMORY_INJECT_MAX_CHARS;"""


def ensure(cond, msg):
    if not cond:
        print('FAIL: ' + msg)
        sys.exit(1)


if MARKER in SRC:
    print('already patched, skip')
    sys.exit(0)

ensure(SRC.count(OLD) == 1, "锚点 sharedMemoryMaxChars 命中数 = %d，期望 1" % SRC.count(OLD))

SRC = SRC.replace(OLD, NEW, 1)

# 全局复检：模块层的接线块里不得再出现裸 bounded(
# 注意：别拿 'bounded is not defined' 当断言 —— 新代码的注释里为了说明原因
# 就写着这句话，断言会把自己拦住（第一次跑就是这么 FAIL 的）。
seg_start = SRC.find('// MARKER: shared-memory-wire')
seg_end = SRC.find('// MARKER: share-signal-wire')
ensure(seg_start > 0 and seg_end > seg_start, '找不到 shared-memory 接线段')
seg = SRC[seg_start:seg_end]
# 只看真正的代码行：注释里为了说明原因会写「不能调 bounded()」，那是文字不是调用。
code_lines = [l for l in seg.split('\n') if not l.lstrip().startswith('//')]
ensure(not any('bounded(' in l for l in code_lines),
       '接线层里还有 bounded( 调用：\n' +
       '\n'.join(l for l in code_lines if 'bounded(' in l))

io.open(TARGET, 'w', encoding='utf-8').write(SRC)
print('patched: sharedMemoryMaxChars 改为就地夹紧，不再依赖局部 bounded()')
print('bytes: %d' % len(SRC))
