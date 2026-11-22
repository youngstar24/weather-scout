/**
 * verify_B.mjs —— 概率公式独立复算（仅依据「关于/数据说明」文案描述的公式）
 *
 * 文案公式（ws-app.js initAbout）：
 *  1 下雪   P=日降水概率×雪相态概率（气温/逐小时降水时气温<1℃占比）；雪类天气码保底 55%；降雪量≤0.05cm 减半
 *  2 避寒   夜间体感最低温映射（≥18℃=100%…≥12℃=60%，<8℃=5%）
 *  3 观星   夜间(21–04时)云量 55% + 月相暗度 25% + 光污染等级 20%（月相=简化新月周期公式）
 *  4 朝霞晚霞 日出/日落 ±45min 窗口内低+中云散状覆盖（30–70% 最佳，峰值 50%）×60% + 能见度 15% + 干燥 25%
 *
 * 文案未指明的细节采用显式假设（详见输出）：
 *  - 雪相态：「降水时」= 逐小时降水概率 ≥30% 的小时；占比可用时（≥3 小时）直接用 <1℃ 占比；
 *    不足 3 小时文案无公式 → 假设日平均温映射 tmean≤-2→0.9 / ≤0→0.8 / ≤2→0.6 / ≤4→0.3 / >4→0.1
 *  - 避寒中间档：≥16→0.9 / ≥14→0.75 / ≥10→0.35 / ≥8→0.15（案例点不落在中间档时无影响）
 *  - 月相暗度：dark = 1 − 照明度（文案仅说「月相暗度」，未给阶梯映射）
 *  - 光污染：lpF = (5−lp)/4 线性（lp1 极暗=1.0，lp5 城市中心=0.2）
 *  - 散状覆盖 = 1−(1−低云)(1−中云)（低/中云相互独立出现的并集概率）
 *  - 散状覆盖得分 = 三角形峰值函数：1−|sc−50|/50（0% 与 100% 为 0 分，50% 峰值 1 分）
 *  - 能见度分 = clamp((vis−5)/15, 0.05, 1)（vis 单位 km，5km→0.05，20km→1.0）
 *  - 窗口小时 = 与 [中心−45min, 中心+45min] 有重叠的小时
 */
import { loadCache, loadPoi, loadModel, clamp, locList } from './lib.mjs';

const cache = loadCache();
const poi = loadPoi();
const M = loadModel();
const dailyTime = cache.dailyTime;
// D7 双口径：任务描述按「第 N 个预报日」= 索引 6（2026-11-27）；页面日期轴 D7 按钮 = 索引 7（2026-11-28）
const D7_IDX = [6, 7];

/* ================= 独立实现 ================= */

// 1) 下雪
function mySnow(wx, d) {
  const pprob = wx.daily.precipitation_probability_max[d] ?? 0;
  const snowSum = wx.daily.snowfall_sum[d] ?? 0;
  const tmax = wx.daily.temperature_2m_max[d], tmin = wx.daily.temperature_2m_min[d];
  const tmean = (tmax + tmin) / 2;
  let phase, phaseSrc;
  const precipHours = [];
  for (let h = 0; h < 24; h++) {
    const pp = wx.hourly.precipitation_probability[d * 24 + h];
    if (pp !== null && pp !== undefined && pp >= 30) precipHours.push({ h, t: wx.hourly.temperature_2m[d * 24 + h] });
  }
  if (precipHours.length >= 3) {
    phase = precipHours.filter(x => x.t !== null && x.t < 1).length / precipHours.length;
    phaseSrc = `逐小时降水时<1℃占比 ${precipHours.filter(x => x.t !== null && x.t < 1).length}/${precipHours.length}`;
  } else {
    phase = tmean <= -2 ? 0.9 : tmean <= 0 ? 0.8 : tmean <= 2 ? 0.6 : tmean <= 4 ? 0.3 : 0.1;
    phaseSrc = `文案未指明短时数回退公式 → 假设日均温映射(${tmean.toFixed(1)}℃)`;
  }
  const SNOW_CODES = [71, 73, 75, 77, 85, 86];
  let p = pprob * phase;
  if (SNOW_CODES.includes(wx.daily.weather_code[d])) p = Math.max(p, 55);
  if (snowSum <= 0.05) p *= 0.5;
  p = clamp(p, 2, 98);
  return { p, parts: { pprob, phase, phaseSrc, snowSum, code: wx.daily.weather_code[d], tmean: +tmean.toFixed(2) } };
}

// 2) 避寒
function myWarm(wx, d) {
  const at = wx.daily.apparent_temperature_min[d] ?? -99;
  const comfort = at >= 18 ? 1 : at >= 16 ? 0.9 : at >= 14 ? 0.75 : at >= 12 ? 0.6 : at >= 10 ? 0.35 : at >= 8 ? 0.15 : 0.05;
  const p = clamp(100 * comfort, 2, 98);
  return { p, parts: { atMin: at, comfort } };
}

// 3) 观星
function myMoon(dateStr) {
  const t = Date.parse(dateStr + 'T12:00:00Z');
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const syn = 29.530588853 * 86400000;
  const age = (((t - ref) % syn) + syn) % syn / 86400000;
  const illum = (1 - Math.cos(2 * Math.PI * age / 29.530588853)) / 2;
  return { age, illum };
}
function myStars(wx, d, lp, dateStr) {
  let sum = 0, n = 0;
  for (let h = 21; h <= 23; h++) { const v = wx.hourly.cloud_cover[d * 24 + h]; if (v !== null && v !== undefined) { sum += v; n++; } }
  for (let h = 0; h <= 4; h++) { const v = wx.hourly.cloud_cover[(d + 1) * 24 + h]; if (v !== null && v !== undefined) { sum += v; n++; } }
  const nightCloud = n ? sum / n : null;
  const mp = myMoon(dateStr);
  const dark = 1 - mp.illum;                 // 假设：暗度=1−照明度
  const lpF = (5 - lp) / 4;                  // 假设：线性映射
  const p = clamp(100 * (0.55 * (1 - nightCloud / 100) + 0.25 * dark + 0.2 * lpF), 2, 98);
  return { p, parts: { nightCloud: +nightCloud.toFixed(1), age: +mp.age.toFixed(2), illum: +mp.illum.toFixed(3), dark: +dark.toFixed(3), lp, lpF } };
}

// 4) 朝霞晚霞
function myGlow(wx, d) {
  const sr = /T(\d{2}):(\d{2})/.exec(wx.daily.sunrise[d]), ss = /T(\d{2}):(\d{2})/.exec(wx.daily.sunset[d]);
  const pprob = wx.daily.precipitation_probability_max[d] ?? 0;
  const dry = 1 - pprob / 100;
  const scatterScore = (sc) => sc === null ? 0.4 : 1 - Math.abs(sc - 50) / 50;   // 假设：三角形峰
  const evalWin = (hm) => {
    if (!hm) return { score: 0 };
    const center = +hm[1] * 60 + +hm[2];
    const wFrom = center - 45, wTo = center + 45;
    const hours = [];
    for (let h = 0; h < 24; h++) if (h * 60 < wTo && (h + 1) * 60 > wFrom) hours.push(h); // 与窗口有重叠
    const mean = v => { let s = 0, k = 0; for (const h of hours) { const x = wx.hourly[v][d * 24 + h]; if (x !== null && x !== undefined) { s += x; k++; } } return k ? s / k : null; };
    const low = mean('cloud_cover_low'), mid = mean('cloud_cover_mid'), vis = mean('visibility');
    const scatter = (low === null || mid === null) ? null : 100 * (1 - (1 - low / 100) * (1 - mid / 100));
    const visS = vis === null ? 0.7 : clamp((vis - 5) / 15, 0.05, 1);
    const score = 0.6 * scatterScore(scatter) + 0.15 * visS + 0.25 * dry;
    return { score, scatter, vis, hours };
  };
  const m = evalWin(sr), e = evalWin(ss);
  const pick = e.score >= m.score ? e : m;
  const p = clamp(100 * pick.score, 2, 98);
  return { p, parts: { morning: +m.score.toFixed(4), evening: +e.score.toFixed(4), pickEvening: e.score >= m.score, scatter: pick.scatter === null ? null : +pick.scatter.toFixed(1), vis: pick.vis === null ? null : +pick.vis.toFixed(1), dry: +dry.toFixed(3), hours: pick.hours } };
}

/* ================= 与模型对比 ================= */
function wxOf(id) { return cache.wx[id]; }
function locOf(id) { const p = poi.pois.find(x => x.id === id) || poi.cities.find(x => x.id === id); return { ...p, kind: poi.cities.some(x => x.id === id) ? 'city' : 'poi' }; }

const cases = [
  { id: 'changbaishan', key: 'snow', label: '长白山天池 D7 下雪' },
  { id: 'yalongwan', key: 'warm', label: '三亚亚龙湾 D7 避寒' },
  { id: 'changbaishan', key: 'stars', label: '长白山天池 D7 观星' },
  { id: 'huangshan', key: 'glow', label: '黄山 D7 朝霞晚霞' },
  { id: 'changbaishan', key: 'glow', label: '长白山天池 D7 朝霞晚霞' },
];
const rows = [];
for (const c of cases) {
  for (const d of D7_IDX) {
    const loc = locOf(c.id), wx = wxOf(c.id);
    const mine = c.key === 'snow' ? mySnow(wx, d) : c.key === 'warm' ? myWarm(wx, d) : c.key === 'stars' ? myStars(wx, d, loc.lp, dailyTime[d]) : myGlow(wx, d);
    const model = M.compute(wx, d, c.key, loc.lp, dailyTime[d]);
    const diff = +(mine.p - model.p).toFixed(1);
    const pass = Math.abs(diff) <= 5;
    rows.push({ label: `${c.label}（${d === 6 ? '第7个预报日/11-27' : '页面D7按钮/11-28'}）`, key: c.key, date: dailyTime[d], mine: +mine.p.toFixed(1), model: +model.p.toFixed(1), modelRounded: Math.round(model.p), diff, pass, parts: mine.parts, modelParts: model.parts, window: model.window, qualityModel: model.quality });
    console.log(`${c.label} @${dailyTime[d]}(idx${d}) 独立复算=${mine.p.toFixed(1)}% 模型=${model.p.toFixed(1)}%（页面四舍五入 ${Math.round(model.p)}%） 偏差=${diff}pp ${pass ? 'PASS' : 'FAIL'}`);
    console.log(`   我的中间量: ${JSON.stringify(mine.parts)}`);
    console.log(`   模型中间量: ${JSON.stringify(model.parts)} 窗口: ${model.window}`);
  }
}
console.log('\n月相参考（模型 myMoon 与独立实现同公式）:', JSON.stringify(Object.fromEntries(D7_IDX.map(d => [dailyTime[d], myMoon(dailyTime[d])]))));

/* ================= D4 预备：订阅命中复算（snow 全国 D5–D7 ≥50%，索引 5..7 与订阅表单默认一致） ================= */
const sub = { lands: ['snow'], origin: 'city-beijing', rings: [], from: 5, to: 7, thr: 50 };
const hits = [];
for (const loc of locList(poi)) {
  if (!wxOf(loc.id)) continue;
  let bestHit = null;
  for (let d = sub.from; d <= sub.to; d++) {
    const res = M.computeAll(wxOf(loc.id), d, loc.lp, dailyTime[d]);
    const r = res[sub.lands[0]];
    if (r && r.p >= sub.thr && (!bestHit || r.p > bestHit.p)) bestHit = { key: sub.lands[0], p: r.p, d };
  }
  if (bestHit) hits.push({ id: loc.id, name: loc.name, p: +bestHit.p.toFixed(1), d: bestHit.d });
}
hits.sort((a, b) => b.p - a.p);
console.log(`\n订阅复算（snow 全国 索引D${sub.from}–D${sub.to} ≥${sub.thr}%）：命中 ${hits.length} 个位置`);
console.log('Top10:', hits.slice(0, 10).map(h => `${h.name} ${h.p}% idx${h.d}`).join(' · '));

import fs from 'node:fs';
fs.writeFileSync(new URL('./b_recalc_result.json', import.meta.url), JSON.stringify({ rows, subHitCount: hits.length, subHits: hits, dailyTime }, null, 1));
