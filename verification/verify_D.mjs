/**
 * verify_D.mjs —— 语义一致性抽查
 * D1 日出日落合理性 / D2 单位检查 / D3 网格点检查 / D4 预备（D7 单日候选数）
 */
import { loadCache, loadPoi, loadModel, locList } from './lib.mjs';

const cache = loadCache();
const poi = loadPoi();
const M = loadModel();
const dailyTime = cache.dailyTime;
const out = { d1: {}, d2: {}, d3: {}, d4: {} };
const D7 = 6;

/* ---------- D1 日出日落 ---------- */
function hm(iso) { return iso ? iso.slice(11, 16) : null; }
for (const id of ['city-beijing', 'city-sanya', 'yalongwan', 'mohe-beijicun']) {
  const wx = cache.wx[id];
  out.d1[id] = {
    date: dailyTime[D7],
    sunrise: hm(wx.daily.sunrise[D7]),
    sunset: hm(wx.daily.sunset[D7]),
  };
}
console.log('D1 日出日落（D7=' + dailyTime[D7] + '）:', JSON.stringify(out.d1));

/* ---------- D2 单位 ---------- */
const bj = cache.wx['city-beijing'];
out.d2.beijing_visibility = { min: Math.min(...bj.hourly.visibility), max: Math.max(...bj.hourly.visibility), unit: 'km（缓存由 m/1000 取整）', nulls: bj.hourly.visibility.filter(v => v === null).length };
out.d2.beijing_temp_D7 = { tmax: bj.daily.temperature_2m_max[D7], tmin: bj.daily.temperature_2m_min[D7] };
out.d2.changbaishan_snowfall_sum_D7_cm = cache.wx['changbaishan'].daily.snowfall_sum[D7];
out.d2.changbaishan_hourly_snowfall_D7 = cache.wx['changbaishan'].hourly.snowfall.slice(D7 * 24, D7 * 24 + 24).filter(v => v > 0).slice(0, 10);
// 云量范围（全缓存抽样）
let cmin = 101, cmax = -1, bad = 0, n = 0;
for (const [id, wx] of Object.entries(cache.wx)) {
  if (!wx.hourly) continue;
  for (const v of wx.hourly.cloud_cover) { if (v === null) continue; cmin = Math.min(cmin, v); cmax = Math.max(cmax, v); if (v < 0 || v > 100) bad++; n++; }
}
out.d2.cloud_cover = { min: cmin, max: cmax, sampled: n, outOfRange: bad };
out.d2.visibilityNullCount_allLocations = Object.values(cache.wx).filter(w => w.hourly).reduce((a, w) => a + w.hourly.visibility.filter(v => v === null).length, 0);
console.log('D2 单位:', JSON.stringify(out.d2, null, 1));

/* ---------- D3 网格 ---------- */
out.d3.gridCount = cache.grid.length;
const land = cache.grid.filter(g => g.land), sea = cache.grid.filter(g => !g.land);
out.d3.landCount = land.length; out.d3.seaCount = sea.length;
const rnd = a => a[Math.floor(Math.random() * a.length)];
const landSample = [rnd(land), rnd(land), rnd(land)].map(g => ({ id: g.id, lat: g.lat, lon: g.lon, hasWx: !!cache.wx[g.id], dailyLen: cache.wx[g.id] ? cache.wx[g.id].daily.weather_code.length : null }));
const seaSample = [rnd(sea), rnd(sea), rnd(sea)].map(g => ({ id: g.id, lat: g.lat, lon: g.lon, hasWx: !!cache.wx[g.id] }));
out.d3.landSample = landSample; out.d3.seaSample = seaSample;
out.d3.allLandHaveWx = land.every(g => !!cache.wx[g.id]);
out.d3.noSeaHasWx = sea.every(g => !cache.wx[g.id]);
console.log('D3 网格:', JSON.stringify(out.d3, null, 1));

/* ---------- D4 预备：D7 单日候选数（默认视图 snow ≥50%） ---------- */
const cand = [];
for (const loc of locList(poi)) {
  if (!cache.wx[loc.id]) continue;
  const r = M.compute(cache.wx[loc.id], D7, 'snow', loc.lp, dailyTime[D7]);
  if (r && r.p >= 50) cand.push({ name: loc.name, p: +r.p.toFixed(1), quality: r.quality });
}
cand.sort((a, b) => b.p - a.p);
out.d4.candidatesD7snow50 = { count: cand.length, list: cand };
console.log('D4 预备（D7 snow≥50% 候选数）:', cand.length, JSON.stringify(cand));

import fs from 'node:fs';
fs.writeFileSync(new URL('./d_semantic_result.json', import.meta.url), JSON.stringify(out, null, 1));
