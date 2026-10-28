// 姓名归一（resolveImpressionWho）的回归守卫。
// 病灶：模型把 QQ 号当名字写回来，同一个人在同一份 memberImpressions 里
// 分身成 `管理员` / `私聊 1124721191` / `1124721191` 三条（2026-10-28 实测）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const mod = await import(pathToFileURL(path.join(process.cwd(), 'src/settle.js')).href);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass += 1; } else { fail += 1; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

const imp = {
  '管理员': { traits: ['舍午觉给我修工具'] },
  '私聊 1124721191': { traits: ['爱发梗图'] },
  '老猫': { traits: ['话少'] }
};
const f = mod.resolveImpressionWho;

check('空 who', f({ key: 'group:1', impressions: imp, who: '' }), '');
check('完全同名', f({ key: 'group:1', impressions: imp, who: '管理员' }), '管理员');
check('QQ 号命中带号的键', f({ key: 'group:1', impressions: imp, who: '1124721191' }), '私聊 1124721191');
check('号前后有字也认', f({ key: 'group:1', impressions: imp, who: '私聊1124721191' }), '私聊 1124721191');
check('短名命中长键', f({ key: 'group:1', impressions: imp, who: '管理员大人' }), '管理员');
check('真新人放行', f({ key: 'group:1', impressions: imp, who: '三十七号' }), '三十七号');
check('空库直接放行', f({ key: 'group:1', impressions: {}, who: '1124721191' }), '1124721191');
check('私聊只剩一个键就归它', f({ key: 'private:1124721191', impressions: { '管理员': { traits: [] } }, who: '那条大肥鱼' }), '管理员');
check('群里只有一个键也不瞎归', f({ key: 'group:906710082', impressions: { '管理员': { traits: [] } }, who: '那条大肥鱼' }), '那条大肥鱼');
check('原型污染常亮', f({ key: 'group:1', impressions: imp, who: '__proto__' }), '');
check('脏空格压平', f({ key: 'group:1', impressions: imp, who: '  老猫  ' }), '老猫');
check('短号前缀也算同一个人', f({ key: 'group:1', impressions: imp, who: '1124721' }), '私聊 1124721191');
check('缺参数兜底', f(), '');
check('impressions 是 null', f({ key: 'group:1', impressions: null, who: '小鱼干' }), '小鱼干');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);