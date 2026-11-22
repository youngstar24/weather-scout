#!/usr/bin/env node
/**
 * build-cache.mjs —— 从 Open-Meteo 真实抓取全国天气数据，生成前端可用的数据文件
 *
 * 产出：
 *   data/ws-data.js   —— 种子 POI/城市数据（window.WS_DATA）
 *   data/ws-cache.js  —— 真实天气缓存（window.WS_CACHE），含抓取时间与请求参数，便于核验复现
 *
 * 运行：node tools/build-cache.mjs
 * 依赖：Node >= 18（使用内置 fetch），无第三方依赖
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

const API = 'https://api.open-meteo.com/v1/forecast';
const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_probability_max', 'precipitation_sum', 'snowfall_sum',
  'sunrise', 'sunset', 'uv_index_max',
];
const HOURLY_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation_probability',
  'snowfall', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'visibility',
];
const TZ = 'Asia/Shanghai';
const FORECAST_DAYS = 16;

/* ---------- 小工具 ---------- */
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round = (v, d) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (res.status === 429) {
        // 每分钟限流：等一个完整窗口再试
        lastErr = new Error('HTTP 429 Minutely rate limit');
        console.warn(`  触发限流(429)，等待 65s 后重试（${i + 1}/${tries}）`);
        await sleep(65_000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`  重试 ${i + 1}/${tries} 失败：${e.message}`);
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------- 网格点定义（中国大陆范围，3° 降采样） ---------- */
function buildGrid() {
  const pts = [];
  for (let lon = 73; lon <= 135; lon += 3) {
    for (let lat = 18; lat <= 54; lat += 3) {
      pts.push({ id: `g_${lon}_${lat}`, lat, lon });
    }
  }
  return pts;
}

/* ---------- 陆地掩膜：echarts china.json 为 UTF8 压缩编码格式，按其官方算法解码 ---------- */
function decodeEchartsRing(str, offsets, scale) {
  // 移植自 echarts src/coord/geo/parseGeoJson.js::decodePolygon（Apache-2.0）
  const out = [];
  let prevX = offsets[0], prevY = offsets[1];
  for (let i = 0; i < str.length; i += 2) {
    let x = str.charCodeAt(i) - 64;
    let y = str.charCodeAt(i + 1) - 64;
    x = (x >> 1) ^ -(x & 1); // ZigZag 解码
    y = (y >> 1) ^ -(y & 1);
    x += prevX; y += prevY;  // 增量解码
    prevX = x; prevY = y;
    out.push([x / scale, y / scale]);
  }
  return out;
}
function pointInRing(pt, ring) {
  // 射线法（ring: [ [lon,lat], ... ]）
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
async function loadLandmask() {
  const url = 'https://registry.npmmirror.com/echarts/4.9.0/files/map/json/china.json';
  try {
    const gj = await fetchWithRetry(url, 2);
    const scale = gj.UTF8Scale == null ? 1024 : gj.UTF8Scale;
    const polys = []; // 每个 poly = [外环, 内环(洞)...]，环为 [[lon,lat],...]
    for (const f of gj.features || []) {
      const g = f.geometry;
      if (!g || !g.coordinates || !g.coordinates.length) continue;
      if (g.type === 'Polygon') {
        polys.push(g.coordinates.map((ringStr, ri) => decodeEchartsRing(ringStr, g.encodeOffsets[ri], scale)));
      } else if (g.type === 'MultiPolygon') {
        g.coordinates.forEach((poly, pi) => {
          polys.push(poly.map((ringStr, ri) => decodeEchartsRing(ringStr, g.encodeOffsets[pi][ri], scale)));
        });
      }
    }
    console.log(`陆地掩膜：已加载中国边界并解码（${polys.length} 个多边形）`);
    return { polys, source: 'echarts-china-json (npmmirror, UTF8 已解码)' };
  } catch (e) {
    console.warn(`陆地掩膜加载失败（${e.message}），将保留全部格点。`);
    return { polys: null, source: 'none' };
  }
}
function isLand(mask, lat, lon) {
  if (!mask.polys) return true;
  const pt = [lon, lat];
  for (const poly of mask.polys) {
    if (!pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(pt, poly[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

/* ---------- 主流程 ---------- */
async function main() {
  const t0 = Date.now();
  const poiDoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'poi.json'), 'utf8'));
  const pois = poiDoc.pois, cities = poiDoc.cities;

  // 1) 生成 ws-data.js（种子数据）
  const dataJs = `// 自动生成自 data/poi.json —— 请勿手改，修改后重跑 tools/build-cache.mjs\nwindow.WS_DATA = ${JSON.stringify(poiDoc)};\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'ws-data.js'), dataJs);
  console.log(`✓ ws-data.js：${pois.length} 个景区 + ${cities.length} 个城市`);

  // 2) 陆地掩膜 + 网格
  const mask = await loadLandmask();
  const allGrid = buildGrid();
  const grid = allGrid.map(p => ({ ...p, land: isLand(mask, p.lat, p.lon) }));
  const landGrid = grid.filter(p => p.land);
  console.log(`✓ 网格点：${allGrid.length} 个，其中陆地 ${landGrid.length} 个（掩膜源：${mask.source}）`);

  // 3) 组装请求位置
  const hourlyLocs = [...pois, ...cities].map(p => ({ id: p.id, lat: p.lat, lon: p.lon }));
  const dailyLocs = [...hourlyLocs, ...landGrid.map(p => ({ id: p.id, lat: p.lat, lon: p.lon }))];

  const dailyQ = DAILY_VARS.join(',');
  const hourlyQ = HOURLY_VARS.join(',');
  const commonQ = `timezone=${encodeURIComponent(TZ)}&forecast_days=${FORECAST_DAYS}`;

  /** 批量抓取并按 id 归还（并发 3） */
  async function fetchBatches(locs, vars, batch, label) {
    const out = new Map();
    const groups = chunk(locs, batch);
    const worker = async (gi) => {
      const g = groups[gi];
      const url = `${API}?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&${vars}&${commonQ}`;
      let data = await fetchWithRetry(url);
      if (!Array.isArray(data)) data = [data];
      if (data.length !== g.length) throw new Error(`${label} 批次 ${gi + 1} 返回数量不符：${data.length} != ${g.length}`);
      data.forEach((item, i) => {
        const d = item.daily, h = item.hourly;
        if (label !== 'daily' && (!h || !h.time || h.time.length !== FORECAST_DAYS * 24)) {
          throw new Error(`${g[i].id} 逐小时数据长度异常`);
        }
        if (!d || !d.time || d.time.length !== FORECAST_DAYS) throw new Error(`${g[i].id} 逐日数据长度异常`);
        const rec = { elev: item.elevation, lat: item.latitude, lon: item.longitude, daily: {}, dailyTime: d.time };
        for (const v of DAILY_VARS) rec.daily[v] = d[v];
        if (h) {
          rec.hourly = {};
          rec.hourlyTime = h.time;
          for (const v of HOURLY_VARS) rec.hourly[v] = h[v];
        }
        out.set(g[i].id, rec);
      });
      console.log(`  ${label} 批次 ${gi + 1}/${groups.length} 完成（${g.length} 个点）`);
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
      while (next < groups.length) { const gi = next++; await worker(gi); }
    }));
    return out;
  }

  console.log(`开始抓取 Open-Meteo：daily ${dailyLocs.length} 点 / hourly ${hourlyLocs.length} 点`);
  const dailyMap = await fetchBatches(dailyLocs, `daily=${dailyQ}`, 90, 'daily');
  const hourlyMap = await fetchBatches(hourlyLocs, `daily=${dailyQ}&hourly=${hourlyQ}`, 45, 'daily+hourly');

  // 4) 组装缓存
  const wx = {};
  for (const [id, rec] of dailyMap) {
    wx[id] = { elev: rec.elev, daily: rec.daily };
    const hh = hourlyMap.get(id);
    if (hh) {
      wx[id].hourly = hh.hourly;
      wx[id].hourly.temperature_2m = hh.hourly.temperature_2m.map(v => round(v, 1));
      wx[id].hourly.relative_humidity_2m = hh.hourly.relative_humidity_2m.map(v => (v === null ? null : Math.round(v)));
      wx[id].hourly.precipitation_probability = hh.hourly.precipitation_probability.map(v => (v === null ? null : Math.round(v)));
      wx[id].hourly.snowfall = hh.hourly.snowfall.map(v => round(v, 2));
      wx[id].hourly.cloud_cover = hh.hourly.cloud_cover.map(v => (v === null ? null : Math.round(v)));
      wx[id].hourly.cloud_cover_low = hh.hourly.cloud_cover_low.map(v => (v === null ? null : Math.round(v)));
      wx[id].hourly.cloud_cover_mid = hh.hourly.cloud_cover_mid.map(v => (v === null ? null : Math.round(v)));
      wx[id].hourly.visibility = hh.hourly.visibility.map(v => (v === null ? null : Math.round(v / 1000))); // m → km
    }
  }
  // 逐小时坐标以 daily 批返回值为准（lat/lon 已含在 dailyMap）

  const firstHourly = hourlyMap.values().next().value;
  const firstDaily = dailyMap.values().next().value;
  const cache = {
    version: 1,
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    forecastDays: FORECAST_DAYS,
    dailyTime: firstDaily.dailyTime,
    hourlyTime: firstHourly.hourlyTime,
    source: {
      name: 'Open-Meteo',
      url: API,
      license: 'CC BY 4.0（免费非商业使用）',
      requestTemplate: `${API}?latitude=<lat,csv>&longitude=<lon,csv>&daily=${dailyQ}&hourly=<hourlyQ 或省略>&${commonQ}`,
      dailyVars: DAILY_VARS,
      hourlyVars: HOURLY_VARS,
    },
    landmaskSource: mask.source,
    grid: grid.map(p => ({ id: p.id, lat: p.lat, lon: p.lon, land: p.land })),
    locations: [
      ...pois.map(p => ({ id: p.id, type: 'poi', name: p.name, prov: p.prov, lat: p.lat, lon: p.lon, type2: p.type, lp: p.lp, tags: p.tags })),
      ...cities.map(c => ({ id: c.id, type: 'city', name: c.name, prov: c.prov, lat: c.lat, lon: c.lon, type2: 'city', lp: 5, tags: [] })),
    ],
    wx,
  };

  const js = `// 自动生成于 ${cache.generatedAt} —— 数据来源 Open-Meteo（真实抓取），请勿手改\nwindow.WS_CACHE = ${JSON.stringify(cache)};\n`;
  fs.writeFileSync(path.join(DATA_DIR, 'ws-cache.js'), js);

  const kb = (fs.statSync(path.join(DATA_DIR, 'ws-cache.js')).size / 1024).toFixed(0);
  console.log(`✓ ws-cache.js：${Object.keys(wx).length} 个位置，${kb} KB，抓取用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 5) 简单完整性校验
  const missing = [...pois, ...cities].filter(p => !wx[p.id]).map(p => p.id);
  if (missing.length) throw new Error(`缺少天气数据的位置：${missing.join(', ')}`);
  const nullPprob = Object.entries(wx).filter(([, v]) => v.daily.precipitation_probability_max.some(x => x === null)).length;
  console.log(`✓ 完整性：POI/城市全部有数据；降水概率含 null 的位置数：${nullPprob}`);
}

main().catch(e => { console.error('构建失败：', e); process.exit(1); });
