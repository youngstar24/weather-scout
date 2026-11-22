/**
 * verify_A.mjs —— 管道真实性核验：缓存 vs Open-Meteo 官方 API 逐字段比对
 * 抽查 12 个代表位置 × 3 个日期（D1=索引0 / D7=索引6 / D15=索引14）
 * 单位置请求，节奏 ≥3s/次，429 退避 65s。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadCache() {
  const s = fs.readFileSync(path.join(ROOT, 'data', 'ws-cache.js'), 'utf8');
  const i = s.indexOf('window.WS_CACHE');
  const start = s.indexOf('{', i), end = s.lastIndexOf('}') + 1;
  return JSON.parse(s.slice(start, end));
}

const DAILY_VARS = ['weather_code','temperature_2m_max','temperature_2m_min','apparent_temperature_max','apparent_temperature_min','precipitation_probability_max','precipitation_sum','snowfall_sum','sunrise','sunset','uv_index_max'];
const HOURLY_VARS = ['temperature_2m','relative_humidity_2m','precipitation_probability','snowfall','cloud_cover','cloud_cover_low','cloud_cover_mid','visibility'];

const LOC_IDS = ['changbaishan','kanasi','yalongwan','potala','city-chengdu','city-harbin','huangshan','mohe-beijicun','beihai-yintan','city-urumqi','city-beijing','huashan'];
// 覆盖两种日期口径：第1/7/15个预报日（0基索引 0/6/14）与页面 D1/D7/D15 按钮（索引 1/7/15）
const D_IDX = [0, 1, 6, 7, 14, 15];

let apiRequests = 0, http429 = 0;

async function fetchUnit(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=${DAILY_VARS.join(',')}&hourly=${HOURLY_VARS.join(',')}` +
    `&timezone=Asia%2FShanghai&forecast_days=16`;
  for (let tries = 0; tries < 4; tries++) {
    apiRequests++;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (res.status === 429) {
      http429++;
      console.warn(`  429 ${loc.id}：等待 65s 重试`);
      await sleep(65000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${loc.id}`);
    return await res.json();
  }
  throw new Error(`429 未恢复：${loc.id}`);
}

/* ---------- 缓存侧的舍入规则（与 build-cache.mjs 一致，用于规整 API 原始值） ---------- */
const r1 = v => v == null ? null : Number(Number(v).toFixed(1));
const rInt = v => v == null ? null : Math.round(v);
const r2 = v => v == null ? null : Number(Number(v).toFixed(2));
const visKm = v => v == null ? null : Math.round(v / 1000);
const HOURLY_TRANSFORM = {
  temperature_2m: r1, relative_humidity_2m: rInt, precipitation_probability: rInt,
  snowfall: r2, cloud_cover: rInt, cloud_cover_low: rInt, cloud_cover_mid: rInt, visibility: visKm,
};

/* ---------- 逐字段比较 ---------- */
function cmpNum(a, b, tol) {
  if (a === null && b === null) return { ok: true, diff: 0 };
  if (a === null || b === null) return { ok: false, diff: null };
  const diff = Math.abs(Number(a) - Number(b));
  return { ok: diff <= tol, diff };
}
function cmpProb(a, b) { // 降水概率：整数须一致；API 若有小数先四舍五入
  if (a === null && b === null) return { ok: true, diff: 0 };
  if (a === null || b === null) return { ok: false, diff: null };
  const diff = Math.abs(Math.round(Number(b)) - Number(a));
  return { ok: diff === 0, diff };
}
function cmpHM(a, b) { // 日出日落 时:分
  const ha = a ? a.slice(11, 16) : null, hb = b ? b.slice(11, 16) : null;
  return { ok: ha === hb, diff: ha === hb ? 0 : `${hb} vs ${ha}` };
}

const cache = loadCache();
const dailyTime = cache.dailyTime;
console.log('缓存 generatedAt:', cache.generatedAt);
console.log('D1/D7/D15 日期:', D_IDX.map(i => `${dailyTime[i]}(idx${i})`).join(' / '));

const report = [];
const summary = { pass: 0, fail: 0, driftRetried: 0 };

for (const id of LOC_IDS) {
  const loc = cache.locations.find(l => l.id === id);
  if (!loc) { console.error('位置不存在于缓存:', id); continue; }
  const wx = cache.wx[id];
  await sleep(3000); // 节奏 ≤1 次/3 秒
  const api = await fetchUnit(loc);
  const rec = { id, name: loc.name, lat: loc.lat, lon: loc.lon, apiLat: api.latitude, apiLon: api.longitude,
    apiElev: api.elevation, cacheElev: wx.elev, daily: [], hourly: [] };

  // 坐标/海拔
  rec.coordDelta = { lat: Math.abs(api.latitude - loc.lat), lon: Math.abs(api.longitude - loc.lon), elev: Math.abs(api.elevation - wx.elev) };

  const apiTime = api.daily.time;
  for (const di of D_IDX) {
    const date = dailyTime[di];
    const ai = apiTime.indexOf(date);
    if (ai < 0) { rec.daily.push({ date, error: 'API 返回不含该日期' }); summary.fail++; continue; }
    const fields = {};
    for (const v of DAILY_VARS) {
      const cVal = wx.daily[v][di], aVal = api.daily[v][ai];
      let r;
      if (v === 'weather_code') r = { ok: Number(cVal) === Number(aVal), diff: Number(aVal) - Number(cVal) };
      else if (v === 'sunrise' || v === 'sunset') r = cmpHM(cVal, aVal);
      else if (v === 'precipitation_probability_max') r = cmpProb(cVal, aVal);
      else r = cmpNum(cVal, aVal, 0.5);
      fields[v] = { cache: cVal, api: aVal, ok: r.ok, diff: r.diff };
    }
    rec.daily.push({ date, fields });
  }
  // 逐小时：3 个日期各 24 小时全部比对（按缓存舍入规则规整后要求一致）
  const apiH = api.hourly;
  for (const di of D_IDX) {
    const date = dailyTime[di];
    for (let h = 0; h < 24; h++) {
      const iso = `${date}T${String(h).padStart(2, '0')}:00`;
      const ai = apiH.time.indexOf(iso);
      if (ai < 0) { rec.hourly.push({ iso, error: 'API 无该小时' }); continue; }
      const row = {};
      for (const v of HOURLY_VARS) {
        const cVal = wx.hourly[v][di * 24 + h];
        const aVal = HOURLY_TRANSFORM[v](apiH[v][ai]);
        const ok = (cVal === null && aVal === null) || (cVal !== null && aVal !== null && Math.abs(cVal - aVal) < 1e-9);
        row[v] = { cache: cVal, apiRaw: apiH[v][ai], apiRounded: aVal, ok };
      }
      rec.hourly.push({ iso, vars: row });
    }
  }

  // 统计
  let f = 0, t = 0;
  for (const d of rec.daily) for (const v of Object.keys(d.fields || {})) { d.fields[v].ok ? t++ : f++; }
  let hf = 0, ht = 0;
  const badHours = [];
  for (const h of rec.hourly) {
    if (!h.vars) continue;
    for (const v of Object.keys(h.vars)) { h.vars[v].ok ? ht++ : hf++; if (!h.vars[v].ok) badHours.push(`${h.iso} ${v}: cache=${h.vars[v].cache} apiRaw=${h.vars[v].apiRaw}`); }
  }
  rec.stats = { dailyOK: t, dailyFail: f, hourlyOK: ht, hourlyFail: hf };
  console.log(`${id.padEnd(15)} ${loc.name.padEnd(8, '　')} daily ${t}✓/${f}✗ hourly ${ht}✓/${hf}✗ coordΔ(lat/lon/elev)=${rec.coordDelta.lat}/${rec.coordDelta.lon}/${rec.coordDelta.elev.toFixed(1)}m`);
  if (badHours.length) console.log('   不一致样例:', badHours.slice(0, 5).join(' | '));
  if (f + hf > 0) {
    // 复跑一次确认是否为模型运行时漂移
    summary.driftRetried++;
    await sleep(3000);
    const api2 = await fetchUnit(loc);
    const ai0 = api2.daily.time.indexOf(dailyTime[0]);
    console.log(`   [复跑 ${id}] D1 tmax 第二次: ${api2.daily.temperature_2m_max[ai0]}（第一次 ${api.daily.temperature_2m_max[api.daily.time.indexOf(dailyTime[0])]}，缓存 ${wx.daily.temperature_2m_max[0]}）`);
    rec.recheckD1Tmax = { run1: api.daily.temperature_2m_max[api.daily.time.indexOf(dailyTime[0])], run2: api2.daily.temperature_2m_max[ai0], cache: wx.daily.temperature_2m_max[0] };
  }
  summary.pass += t + ht; summary.fail += f + hf;
  report.push(rec);
}

fs.writeFileSync(path.join(__dirname, 'a_compare_result.json'), JSON.stringify({ generatedAt: cache.generatedAt, summary, apiRequests, http429, report }, null, 1));
console.log(`\n=== A 节汇总：一致 ${summary.pass} 项 / 不一致 ${summary.fail} 项；API 请求数 ${apiRequests}（含 429 ${http429} 次，复跑重取 ${summary.driftRetried} 个位置）===`);
