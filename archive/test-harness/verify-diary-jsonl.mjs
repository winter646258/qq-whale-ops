// 日记 jsonl 接线验证。
//   node verify-diary-jsonl.mjs ./bridge.rehearsal.js ./mcp.rehearsal.js
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const bPath = process.argv[2] || './bridge.rehearsal.js';
const mPath = process.argv[3] || './mcp.rehearsal.js';
const b = fs.readFileSync(bPath, 'utf8').replace(/\r\n/g, '\n');
const m = fs.readFileSync(mPath, 'utf8').replace(/\r\n/g, '\n');

section('存储真的换到 jsonl 了');
ok('import 了 diary-store', b.includes("from './diary-store.js'"));
ok('DIARY_FILE 指向 jsonl', /DIARY_FILE = path\.join\(ROOT, 'diary', DIARY_JSONL\)/.test(b));
ok('保留旧 md 只读路径', /DIARY_LEGACY = path\.join\(ROOT, 'diary', DIARY_LEGACY_MD\)/.test(b));
ok('不再往 日记.md 写', !/const DIARY_FILE = path\.join\(ROOT, 'diary', '日记\.md'\)/.test(b));

section('旧时间戳 bug 已消除');
ok('不再用 toISOString 生成日记时间戳',
  !/const stamp = new Date\(\)\.toISOString\(\)\.slice\(0, 16\)\.replace\('T', ' '\);/.test(b));
ok('改用 diary-store 的本地时间（append 里由模块负责）', b.includes('appendDiaryEntry(entries'));
ok('写入走 writeDiary（原子写）', b.includes('writeDiary(DIARY_FILE, entries)'));

section('读写路径');
ok('读走 readDiary', b.includes('readDiary(DIARY_FILE)'));
ok('最近 N 条走 recentDiary', b.includes('recentDiary(entries, limit)'));
ok('改写走 updateDiaryEntry', b.includes('updateDiaryEntry(entries,'));
ok('给模型的是可读行（不是原始 JSON）', /recent: recent\.map\(\(e\) => `\[\$\{e\.time/.test(b));

section('只读降级闸（读取失败不许覆盖）');
ok('有 diaryWritable 标志', /let diaryWritable = globalThis\.__diaryWritable !== false;/.test(b));
ok('读失败时置 false', /diaryWritable = false;/.test(b));
ok('写之前先检查只读', /if \(!diaryWritable\) \{ sendJson\(\{ ok: false, error: '日记库当前为只读/.test(b));

section('容量上限');
ok('上限来自模块常量', /maxBytes: DIARY_MAX_BYTES/.test(b) && /maxEntries: DIARY_MAX_ENTRIES/.test(b));
ok('写后校验字节数', /if \(bytes > DIARY_MAX_BYTES\)/.test(b));

section('迁移端点（仅控制台）');
ok('有 migrate 端点', /url\.pathname === '\/api\/socialV2\/diary\/migrate'/.test(b));
ok('幂等：目标已有内容就跳过', /skipped: true, reason: '目标 jsonl 已有内容，不覆盖'/.test(b));
ok('迁移用 parseLegacyMarkdown', b.includes('parseLegacyMarkdown(legacy)'));
ok('迁移端点不接受 agent token 角色调用（无工具描述指向它）',
  !/qq_diary[\s\S]{0,600}diary\/migrate/.test(m));

section('MCP 工具：加了 mood，但仍克制');
ok('qq_diary 有 mood 参数', /mood: z\.string\(\)\.optional\(\)/.test(m));
ok('mood 描述明确「不想标就不传」', /不想标就不传，别硬凑/.test(m));
ok('mood 没有枚举（不塞固定档位）', !/mood: z\.enum\(/.test(m));
ok('支持按 id 改写', /id: z\.string\(\)\.optional\(\)\.describe\('mode=replace/.test(m));
ok('有 text 或有 mood 都能写', /if \(text \|\| mood\)/.test(m));
ok('写的时候带上 mood', /body: JSON\.stringify\(\{ key, token, text, mood,/.test(m));
ok('描述不提存储格式（她不需要知道是 jsonl）', !/qq_diary[\s\S]{0,400}(jsonl|\.md)/.test(m));

section('没引入回归');
ok('日记工具开关还在', /qq_diary: 'diary'/.test(m));
ok('相册逻辑没被改坏', b.includes('const ALBUM_DIR = path.join(ROOT, \'album\')'));
ok('相册写入仍在', b.includes('findMessageMedia(key, messageId)'));
ok('敏感信息拦截还在', b.includes('SENSITIVE_RE.test(text)'));
ok('限流还在', b.includes("scopeCheck('diary')"));
ok('MARKER 数量合理', (b.match(/MARKER: diary-jsonl/g) || []).length >= 5,
  `${(b.match(/MARKER: diary-jsonl/g) || []).length} 处`);

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
