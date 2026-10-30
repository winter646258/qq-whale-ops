// 生活线单测：只测「不越界」「确定性」「至少一个无聊块」这三类容易退化的性质。
// 跑法：node scripts/test-life-timeline.mjs

import { normalizeWorld, minuteOf } from '../src/world.js';
import {
  buildLocalDay,
  dayKeyOf,
  dayStartOf,
  ensureDay,
  envOf,
  expandSlots,
  lifeMomentLine,
  nightOwlOf,
  periodOf,
  pickRegime,
  readTimeline,
  seedOf,
  slotAt,
  summarizeDay,
  weaveIdle,
  writeTimeline
} from '../src/life-timeline.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const WORLD = normalizeWorld({
  version: 2,
  place: {
    city: '南方靠海的小城',
    season: '秋末',
    home: { floor: 5, elevator: false, facing: '东南', rooms: '一室一厅', outside: '马路', keepsake: '旧木椅' },
    places: [
      { name: '书房', note: '关上门就是在忙', noise: '收废品' },
      { name: '客厅', note: '窝着', noise: '电视' },
      { name: '厨房', note: '一口小锅', noise: '水开了' },
      { name: '里间', note: '床', noise: '冰箱' },
      { name: '楼下', note: '早餐铺', noise: '电动车' },
      { name: '堤坝', note: '走十分钟', noise: '潮水' }
    ]
  },
  body: { shape: '不高', tail: { length: '一米', sleep: '侧着', cold: '怕冷', tell: '' }, habits: ['怕静电'] },
  day: {
    wake: '06:00', sleep: '00:30',
    nightOwl: { probability: 1, latestSleep: '03:00', wakeShiftHours: 2, tell: '早上说话短' },
    meals: { morning: '认真吃', noon: '一锅', evening: '随便' },
    rituals: ['隔天买菜']
  },
  hobbies: [
    { name: '刷视频', note: '停不下来', hours: '夜里' },
    { name: '散步', note: '往堤上走', hours: '傍晚' }
  ],
  livelihood: '接零活',
  self: { awareness: 'half', knows: ['被造出来的'], notCare: ['参数'] },
  regimes: [
    {
      id: 'workday', label: '工作日', days: [1, 2, 3, 4, 5],
      blocks: [
        { from: '06:00', to: '07:00', where: '里间', doing: '赖床', body: '', interruptible: 0.5 },
        { from: '07:00', to: '09:00', where: '书房', doing: '摊开活', body: '', interruptible: 0.8 },
        { from: '09:00', to: '11:30', where: '书房', doing: '正经干活', body: '', interruptible: 0.4 },
        { from: '11:30', to: '13:00', where: '厨房', doing: '做饭', body: '', interruptible: 0.8 },
        { from: '13:00', to: '17:00', where: '书房', doing: '接着干', body: '', interruptible: 0.6 },
        { from: '17:00', to: '18:30', where: '堤坝', doing: '往堤上走', body: '', interruptible: 0.9 },
        { from: '18:30', to: '21:00', where: '客厅', doing: '窝着', body: '', interruptible: 0.9 },
        { from: '21:00', to: '00:30', where: '书房', doing: '看书', body: '', interruptible: 0.7 },
        { from: '09:00', to: '10:00', where: '会议室', doing: '越界', body: '', interruptible: 0.5 },
        { from: '22:00', to: '21:00', where: '书房', doing: '倒序', body: '', interruptible: 0.5 }
      ]
    },
    { id: 'weekend', label: '周末', days: [6, 0], blocks: [{ from: '07:30', to: '09:00', where: '里间', doing: '赖床', body: '', interruptible: 0.55 }] }
  ],
  exceptions: [],
  worldDomains: [],
  worldEventRules: { fabricateRealPeople: false },
  env: {
    weatherPool: [{ kind: '晴', temp: '18~25', note: '晒得犯困' }, { kind: '台风', temp: '20', note: '不该出现' }],
    weatherBanned: ['台风'],
    lightByPeriod: { 清晨: '光从东南来', 夜里: '只开一盏台灯' },
    smellPool: ['风里有咸味'],
    boringPool: ['烧了一壶水忘了喝', '数对面楼亮着几盏灯']
  }
});

console.log('【1】展开与越界');
const regime = pickRegime(WORLD, '2026-10-30');
ok('挑到工作日（10-30 是周五）', regime && regime.id === 'workday', `实得 ${regime?.id}`);
const slots = expandSlots(WORLD, regime, '2026-10-30');
ok('越界格（会议室）被丢', !slots.some((s) => s.where === '会议室'));
ok('倒序格（22:00->21:00）被丢', !slots.some((s) => s.from === '22:00'));
ok('留下 8 格', slots.length === 8, `实得 ${slots.length}`);
ok('按开始时间升序', slots.every((s, i) => i === 0 || minuteOf(s.from) >= minuteOf(slots[i - 1].from)));

console.log('【2】确定性（同一天问多少次都一样）');
const a = buildLocalDay(WORLD, { dayKey: '2026-10-30', plans: [] });
const b = buildLocalDay(WORLD, { dayKey: '2026-10-30', plans: [] });
ok('两次生成 doing 序列完全相同', JSON.stringify(a.slots.map((s) => s.doing)) === JSON.stringify(b.slots.map((s) => s.doing)));
const c = buildLocalDay(WORLD, { dayKey: '2026-10-31', plans: [] });
ok('换一天会变（种子不同）', JSON.stringify(a.slots.map((s) => s.doing)) !== JSON.stringify(c.slots.map((s) => s.doing)));

console.log('【3】至少一个无聊块 + 不连续两个正事块');
const isWork = (s) => s.where === '书房' && s.interruptible <= 0.6;
ok('有 boring 标记的格子', a.slots.some((s) => s.boring === true));
let adjacent = 0;
for (let i = 1; i < a.slots.length; i += 1) if (isWork(a.slots[i]) && isWork(a.slots[i - 1])) adjacent += 1;
ok('没有连续两个正事块', adjacent === 0, `实得 ${adjacent} 处`);

console.log('【4】天气不用黑名单里的');
const env = envOf(WORLD, '2026-10-30');
ok('天气不是台风', env.weather?.kind !== '台风', `实得 ${env.weather?.kind}`);
ok('有气味', Boolean(env.smell));

console.log('【5】熬夜日');
const owl = nightOwlOf(WORLD, '2026-10-30');
ok('probability=1 时必熬夜', owl.isOwl === true);
ok('熬夜日醒得晚（06:00 + 2h = 08:00）', owl.wake === '08:00', `实得 ${owl.wake}`);
ok('熬夜日睡到 03:00', owl.sleep === '03:00');
ok('带可观察后果 tell', owl.tell.length > 0);
const noOwl = nightOwlOf(WORLD, '2026-10-30');
ok('同一天两次结果一致（确定性）', noOwl.isOwl === owl.isOwl);

console.log('【6】生活线注入文本');
const day = a;
const at10 = new Date(2026, 9, 30, 10, 0, 0).getTime();
const line = lifeMomentLine(day, at10);
ok('上午 10 点有文本', line.length > 30, `长度 ${line.length}`);
ok('文本里有时段', /现在是 \d{2}:\d{2}–\d{2}:\d{2}/.test(line));
ok('文本里有地点', line.includes('你'));
ok('结尾有「别把整段念出来」', line.includes('别把整段念出来'));
ok('长度在 120~320 之间（别太长）', line.length >= 120 && line.length <= 320, `实得 ${line.length}`);

console.log('【7】slotAt 跨零点');
const early = new Date(2026, 9, 30, 0, 10, 0).getTime();
const s0 = slotAt(day, early);
ok('00:10 仍落在最后一格（21:00–00:30）', s0 && s0.from === '21:00', `实得 ${s0?.from}`);
const before = new Date(2026, 9, 30, 5, 0, 0).getTime();
const s1 = slotAt(day, before);
ok('05:00（还没到 06:00）也落在最后一格', s1 && s1.from === '21:00', `实得 ${s1?.from}`);

console.log('【8】periodOf');
ok('06:30 -> 清晨', periodOf('06:30') === '清晨');
ok('14:00 -> 下午', periodOf('14:00') === '下午');
ok('18:00 -> 傍晚', periodOf('18:00') === '傍晚');
ok('23:00 -> 夜里', periodOf('23:00') === '夜里');
ok('01:00 -> 夜里', periodOf('01:00') === '夜里');

console.log('【9】存取');
const dir = process.env.TMPDIR || '/tmp';
const store0 = readTimeline(dir);
ok('空文件不抛错', store0 && typeof store0.days === 'object');
const saved = writeTimeline(dir, { version: 1, days: { '2026-10-30': day } });
ok('写回带 version', saved.version === 1);
ok('写回有 days', Boolean(saved.days['2026-10-30']));
const back = readTimeline(dir);
ok('读回来还是同一天', Boolean(back.days['2026-10-30']));

console.log('【10】ensureDay 不重排');
const ran1 = ensureDay(dir, WORLD, { dayKey: '2026-10-29', plans: [], force: true });
const ran2 = ensureDay(dir, WORLD, { dayKey: '2026-10-29', plans: [] });
ok('第一次 created=true', ran1.created === true);
ok('第二次 created=false（已有就不重排）', ran2.created === false);
ok('第二次内容与第一次一致', JSON.stringify(ran2.day.slots.map((s) => s.doing)) === JSON.stringify(ran1.day.slots.map((s) => s.doing)));

console.log('【11】summarizeDay / seedOf 稳定性');
ok('摘要非空', summarizeDay(day).length > 10);
ok('seedOf 同参同值', seedOf('2026-10-30', 'x') === seedOf('2026-10-30', 'x'));
ok('seedOf 异参异值', seedOf('2026-10-30', 'x') !== seedOf('2026-10-30', 'y'));
// 【12】【13】用贴近真实的 v4 世界（9 个地方 / 8 个爱好）。
// 上面那份精简 WORLD 只有 6 个地方、没有阳台和公园，用它测地点自洽等于假测。
const WORLD_V4 = normalizeWorld({
  version: 2,
  place: {
    city: '南方靠海的小城', season: '秋末',
    home: { floor: 5, elevator: false, facing: '东南', rooms: '一室一厅', outside: '马路', keepsake: '旧木椅' },
    places: ['书房', '客厅', '厨房', '阳台', '里间', '楼下', '堤坝', '公园', '巷口']
      .map((n) => ({ name: n, note: n, noise: n }))
  },
  body: { shape: '不高', tail: { length: '一米', sleep: '侧着', cold: '怕冷', tell: '' }, habits: ['怕静电'] },
  day: {
    wake: '06:00', sleep: '00:30',
    nightOwl: { probability: 0.2, latestSleep: '03:00', wakeShiftHours: 2, tell: '熬过的那天早上说话短' },
    meals: { morning: '认真吃', noon: '一锅', evening: '随便' }, rituals: ['隔天买菜']
  },
  hobbies: [
    { name: '刷视频', note: '一刷就停不下来' },
    { name: '散步', note: '吃完饭往堤上走' },
    { name: '逛公园', note: '绕湖走一圈，看老人下棋' },
    { name: '逛街', note: '不买，就是看' },
    { name: '读书', note: '淘来的旧书' },
    { name: '学新东西', note: '学到一半被下一个吸引走' },
    { name: '打游戏机', note: '卡关就搁着' },
    { name: '煎鱼', note: '一直没学会' }
  ],
  livelihood: '接零活',
  self: { awareness: 'half', knows: [], notCare: [] },
  regimes: [
    {
      id: 'workday', label: '普通工作日', days: [1, 2, 3, 4, 5],
      blocks: [
        { from: '06:00', to: '06:40', where: '里间', doing: '醒了先躺着，把窗开条缝', interruptible: 0.5 },
        { from: '06:40', to: '07:30', where: '楼下', doing: '下楼买早饭，端回来吃', interruptible: 0.9 },
        { from: '07:30', to: '09:00', where: '书房', doing: '先把手上的活摊开，看看从哪下手', interruptible: 0.8 },
        { from: '09:00', to: '11:30', where: '书房', doing: '正经干活，中间会站起来倒水', interruptible: 0.4 },
        { from: '11:30', to: '12:40', where: '厨房', doing: '做一锅米饭配一个菜', interruptible: 0.8 },
        { from: '12:40', to: '13:40', where: '里间', doing: '中午躺一会儿，其实没睡着', interruptible: 0.6 },
        { from: '13:40', to: '17:00', where: '书房', doing: '接着干，效率比上午差', interruptible: 0.6 },
        { from: '17:00', to: '18:30', where: '堤坝', doing: '吃完饭往堤上走，走十分钟又回来', interruptible: 0.85 },
        { from: '18:30', to: '20:00', where: '客厅', doing: '开着电视不看，手里摸着手机', interruptible: 0.9 },
        { from: '20:00', to: '00:30', where: '书房', doing: '本该干点活，多半在刷视频或看书', interruptible: 0.7 }
      ]
    },
    {
      id: 'weekend', label: '周末', days: [6, 0],
      blocks: [
        { from: '07:30', to: '09:00', where: '里间', doing: '睡到自然醒，赖着不起来', interruptible: 0.55 },
        { from: '09:00', to: '10:00', where: '楼下', doing: '慢慢下楼吃早饭', interruptible: 0.9 },
        { from: '10:00', to: '12:00', where: '公园', doing: '绕湖走一圈，站着看人下棋', interruptible: 0.9 },
        { from: '12:00', to: '13:30', where: '厨房', doing: '认真做顿饭，做完吃一半', interruptible: 0.7 },
        { from: '13:30', to: '15:00', where: '里间', doing: '搬家式午睡', interruptible: 0.35 },
        { from: '15:00', to: '17:30', where: '巷口', doing: '逛街，不买，看到喜欢的记下来', interruptible: 0.85 },
        { from: '17:30', to: '19:00', where: '堤坝', doing: '看海，坐到天黑', interruptible: 0.8 },
        { from: '19:00', to: '00:30', where: '客厅', doing: '打游戏机，卡关就搁着换别的', interruptible: 0.6 }
      ]
    }
  ],
  worldDomains: [], worldEventRules: { fabricateRealPeople: false },
  env: {
    weatherPool: ['晴天，18~25 度', '多云', '阴'],
    lightByPeriod: { 夜里: '只开一盏台灯', 清晨: '光从东南照到桌角', 上午: '亮得很干净', 下午: '屋里一半亮一半暗', 傍晚: '光变橘了' },
    smellPool: ['风里有咸味'], boringPool: [
      '在找一只左耳耳机，翻了三遍口袋',
      '烧了一壶水，忘了喝，凉了又烧',
      '蹲在冰箱前面看有什么能吃的，看了很久什么都没拿',
      '数对面楼亮着几盏灯，数到一半忘了数到哪',
      '把手机里存的地图拖来拖去，看自己住的那条街',
      '头发洗了没吹，就这么湿着',
      '把晾着的衣服翻个面，其实没晒到那一面',
      '打开游戏机又关掉，其实也不知道玩什么'
    ]
  }
});
console.log('【12】地点自洽（线上实测暴露的笑话，任何一条复发都算回归）');
const regress = [];
const realPlans = [
  { period: '上午', text: '煮一锅白饭配咸菜，慢慢吃完' },
  { period: '下午', text: '把窗边那几样挪去晒太阳，顺手发会儿呆' },
  { period: '晚上', text: '翻几页旧书，不赶着画图' }
];
for (const dk of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']) {
  const d = buildLocalDay(WORLD_V4, { dayKey: dk, plans: realPlans });
  const doing = d.slots.map((s) => s.doing);
  if (d.slots.some((s) => s.where === '书房' && /煮|煎|炒|炖|蒸|烤/.test(s.doing))) regress.push(dk + ' 书房做饭');
  if (d.slots.some((s) => ['堤坝', '公园', '巷口'].includes(s.where) && /煮|煎|做饭|洗衣|晾|冰箱|头发|镜子/.test(s.doing))) regress.push(dk + ' 户外做屋里的事');
  for (const h of ['散步', '逛公园', '逛街', '读书', '打游戏机', '刷视频']) {
    if (doing.filter((x) => x.includes(h)).length > 1) regress.push(dk + ' 两次' + h);
  }
  if (d.slots.some((s) => !s.doing || s.doing.length < 4)) regress.push(dk + ' 有空格子');
}
ok('五天无地点错乱、无重复爱好、无空格子', regress.length === 0);
if (regress.length) console.log('   → ' + regress.join('；'));

const dayReal = buildLocalDay(WORLD_V4, { dayKey: '2026-10-30', plans: realPlans });
const cook = dayReal.slots.find((s) => s.doing.includes('煮一锅白饭'));
ok('「煮白饭」落在厨房', Boolean(cook) && cook.where === '厨房');
const sun = dayReal.slots.find((s) => s.doing.includes('挪去晒太阳'));
ok('「挪去晒太阳」落在阳台', Boolean(sun) && sun.where === '阳台');
const book = dayReal.slots.find((s) => s.doing.includes('翻几页旧书'));
ok('「翻旧书」有地方', Boolean(book) && Boolean(book.where));

console.log('【13】熬夜日的后果');
const owlDays = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
  .map((dk) => buildLocalDay(WORLD_V4, { dayKey: dk, plans: [] }))
  .filter((d) => d.nightOwl === true);
ok('八天里确实有熬夜日', owlDays.length >= 1);
ok('熬夜日带可观察后果', owlDays.every((d) => Boolean(d.owlTell)));

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
