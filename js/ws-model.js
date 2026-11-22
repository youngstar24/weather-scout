/**
 * ws-model.js —— 景观概率模型（启发式规则，Demo 阶段）
 * 依据 PRD 2.1/2.2：每个景观输出 发生概率(%) · 观赏质量 · 可信度 · 最佳时段
 * 所有公式在「关于/数据说明」中公开透明；输入为 Open-Meteo 真实预报数据。
 */
(function (global) {
  'use strict';

  /* ---------- 景观定义 ---------- */
  const LANDSCAPES = {
    sunny: { key: 'sunny', name: '晴朗蓝天', icon: '☀️', color: '#e0940a', hint: '云量低、能见度好、降水概率低' },
    snow:  { key: 'snow',  name: '下雪',     icon: '❄️', color: '#3f8ecb', hint: '降水概率 × 雪相态概率（气温判据）' },
    cool:  { key: 'cool',  name: '避暑',     icon: '🌲', color: '#2e9e6b', hint: '白天体感温度 ≤ 28℃ 的舒适概率' },
    warm:  { key: 'warm',  name: '避寒',     icon: '🌴', color: '#e8734a', hint: '夜间体感温度 ≥ 12℃ 的温暖概率' },
    glow:  { key: 'glow',  name: '朝霞晚霞', icon: '🌇', color: '#ef6da8', hint: '日出/日落窗口的中低云量适中 + 能见度' },
    stars: { key: 'stars', name: '观星',     icon: '✨', color: '#6f5bd6', hint: '夜间云量 + 月相 + 光污染等级' },
  };

  const WMO_TEXT = {
    0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴',
    45: '雾', 48: '雾凇/冻雾',
    51: '毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨', 56: '冻毛毛雨', 57: '浓冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪',
    95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴伴冰雹',
  };
  const SNOW_CODES = [71, 73, 75, 77, 85, 86];

  /* ---------- 等时圈近似配置（直线距离 × 出行方式经验半径，非实际路径） ---------- */
  const RINGS = [
    { id: 'drive1', mode: '自驾', hours: 1, km: 70 },
    { id: 'drive2', mode: '自驾', hours: 2, km: 150 },
    { id: 'drive3', mode: '自驾', hours: 3, km: 240 },
    { id: 'rail1',  mode: '高铁', hours: 1, km: 150 },
    { id: 'rail2',  mode: '高铁', hours: 2, km: 320 },
    { id: 'rail3',  mode: '高铁', hours: 3, km: 500 },
  ];

  /* ---------- 基础工具 ---------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toR = Math.PI / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }

  /** 月相：简化天文算法（儒略纪元新月基准，误差 <±0.5 天） */
  function moon(dateStr) {
    const t = Date.parse(dateStr + 'T12:00:00Z');
    const ref = Date.UTC(2000, 0, 6, 18, 14);
    const syn = 29.530588853 * 86400000;
    const age = (((t - ref) % syn) + syn) % syn / 86400000;
    const illum = (1 - Math.cos(2 * Math.PI * age / 29.530588853)) / 2;
    return { age, illum };
  }

  /** 预报可信度（PRD 2.2：D1–3 高 / D4–7 中 / D8–15 低；d 为 0 基索引） */
  function credibility(d) {
    if (d <= 2) return { level: '高', color: '#2e9e6b', opacity: 0.9 };
    if (d <= 6) return { level: '中', color: '#e0a020', opacity: 0.72 };
    return { level: '低', color: '#d64550', opacity: 0.5 };
  }

  const QUALITY_ORDER = ['优', '良', '一般', '较弱'];

  /* ---------- 小时索引/取值 ---------- */
  function hIdx(d, h) { return d * 24 + h; }
  function hVal(wx, d, h, v) {
    const i = hIdx(d, h);
    if (i < 0 || i > 383) return null;
    return wx.hourly[v][i];
  }
  /** 逐小时均值（hFrom>hTo 表示跨午夜），跳过 null */
  function hMean(wx, d, hFrom, hTo, v) {
    let sum = 0, n = 0, dh = 0;
    for (let h = hFrom; ; h++) {
      if (h > 23) { h -= 24; dh = 1; }
      const val = hVal(wx, d + dh, h, v);
      if (val !== null && val !== undefined) { sum += val; n++; }
      if (dh === 1 && h === hTo) break;
      if (dh === 0 && h === hTo) break;
      if (h === hFrom && dh === 1) break;
    }
    return n ? sum / n : null;
  }

  function parseHM(iso) {
    if (!iso) return null;
    const m = /T(\d{2}):(\d{2})/.exec(iso);
    return m ? { h: +m[1], m: +m[2] } : null;
  }
  function fmtHM(hm) { return hm ? String(hm.h).padStart(2, '0') + ':' + String(hm.m).padStart(2, '0') : '—'; }
  function hmShift(hm, min) {
    if (!hm) return null;
    const t = hm.h * 60 + hm.m + min;
    return { h: Math.floor(((t % 1440) + 1440) % 1440 / 60), m: ((t % 60) + 60) % 60 };
  }

  /* ---------- 概率配色 ---------- */
  function probColor(p) {
    if (p == null) return '#c9ccd1';
    if (p < 30) return '#c9ccd1';
    if (p < 50) return '#f6c445';
    if (p < 70) return '#f59e3b';
    if (p < 85) return '#ef6c2e';
    return '#d64550';
  }

  /* ---------- 各景观计算 ---------- */

  // 晴朗蓝天：白天(09–16)总云量 55% + 能见度 20% + 降水概率 25%
  function calcSunny(wx, d) {
    const pprob = wx.daily.precipitation_probability_max[d] ?? 0;
    if (!wx.hourly) {
      const code = wx.daily.weather_code[d];
      const cs = { 0: 0.95, 1: 0.85, 2: 0.5, 3: 0.18, 45: 0.15, 48: 0.1 }[code] ?? (SNOW_CODES.includes(code) ? 0.08 : (code >= 95 ? 0.02 : 0.05));
      const p = clamp(100 * (0.7 * cs + 0.3 * (1 - pprob / 100)), 2, 98);
      return { p, quality: code === 0 ? '优' : code === 1 ? '良' : code === 2 || code === 3 ? '一般' : '较弱', window: '白天', approx: true };
    }
    const cloud = hMean(wx, d, 9, 16, 'cloud_cover');
    const vis = hMean(wx, d, 9, 16, 'visibility'); // km
    const cloudScore = cloud === null ? 0.6 : 1 - cloud / 100;
    const visScore = vis === null ? 0.7 : clamp((vis - 5) / 15, 0.05, 1);
    const dry = 1 - pprob / 100;
    const p = clamp(100 * (0.55 * cloudScore + 0.2 * visScore + 0.25 * dry), 2, 98);
    let quality = '较弱';
    if (cloudScore >= 0.85 && visScore >= 0.8) quality = '优';
    else if (cloudScore >= 0.7 && visScore >= 0.4) quality = '良';
    else if (cloudScore >= 0.45) quality = '一般';
    return { p, quality, window: '白天', parts: { cloud: cloud === null ? null : Math.round(cloud), vis: vis === null ? null : Math.round(vis) } };
  }

  // 下雪：降水概率 × 雪相态概率（气温），天气码/降雪量门控
  function calcSnow(wx, d) {
    const pprob = wx.daily.precipitation_probability_max[d] ?? 0;
    const snowSum = wx.daily.snowfall_sum[d] ?? 0;
    const tmax = wx.daily.temperature_2m_max[d], tmin = wx.daily.temperature_2m_min[d];
    const tmean = (tmax + tmin) / 2;
    let phase = tmean <= -4 ? 0.95 : tmean <= -1 ? 0.88 : tmean <= 1 ? 0.68 : tmean <= 3 ? 0.4 : tmean <= 5 ? 0.15 : 0.03;

    let window = null, winHours = null;
    if (wx.hourly) {
      const precipHours = [], snowHours = [];
      for (let h = 0; h < 24; h++) {
        const pp = hVal(wx, d, h, 'precipitation_probability');
        const t = hVal(wx, d, h, 'temperature_2m');
        const sf = hVal(wx, d, h, 'snowfall');
        if (pp !== null && pp >= 30) precipHours.push({ h, t });
        if (sf !== null && sf > 0.05) snowHours.push(h);
      }
      if (precipHours.length >= 3) {
        const fSnow = precipHours.filter(x => x.t !== null && x.t < 1).length / precipHours.length;
        phase = Math.max(phase, fSnow);
      }
      // 最佳时段：降雪小时 or 高降水概率且低温时段
      const cand = snowHours.length
        ? snowHours
        : (() => { const a = []; for (let h = 0; h < 24; h++) { const pp = hVal(wx, d, h, 'precipitation_probability'); const t = hVal(wx, d, h, 'temperature_2m'); if (pp !== null && pp >= 40 && t !== null && t < 1.5) a.push(h); } return a; })();
      if (cand.length) {
        // 取最长连续段
        let best = [cand[0], cand[0]], cur = [cand[0], cand[0]];
        for (let i = 1; i < cand.length; i++) {
          if (cand[i] === cur[1] + 1) cur[1] = cand[i];
          else cur = [cand[i], cand[i]];
          if (cur[1] - cur[0] > best[1] - best[0]) best = cur;
        }
        winHours = best.slice();
        window = `${String(best[0]).padStart(2, '0')}–${String(Math.min(best[1] + 1, 24)).padStart(2, '0')} 时`;
      }
    }

    const code = wx.daily.weather_code[d];
    let p = pprob * phase;
    if (SNOW_CODES.includes(code)) p = Math.max(p, 55);
    if (snowSum <= 0.05) p *= 0.5;
    p = clamp(p, 2, 98);

    const quality = snowSum >= 3 ? '优' : snowSum >= 1 ? '良' : snowSum >= 0.2 ? '一般' : '较弱';
    return { p, quality, window, winHours, parts: { snowSum, tmean: Math.round(tmean), phase: Math.round(phase * 100) / 100, code } };
  }

  // 避暑：白天体感 ≤28℃ 舒适概率，湿度修正；仅 5–9 月有意义，其他月份返回"非当季"
  function calcCool(wx, d, dateStr) {
    const month = dateStr ? +dateStr.slice(5, 7) : null;
    if (month !== null && ![5, 6, 7, 8, 9].includes(month)) {
      return { p: null, quality: null, window: null, offSeason: true, parts: {} };
    }
    const at = wx.daily.apparent_temperature_max[d] ?? 99;
    const comfort = at <= 24 ? 1 : at <= 26 ? 0.9 : at <= 28 ? 0.7 : at <= 30 ? 0.45 : at <= 32 ? 0.2 : at <= 34 ? 0.08 : 0.03;
    let rh = null, humPen = 1;
    if (wx.hourly) {
      rh = hMean(wx, d, 9, 16, 'relative_humidity_2m');
      if (rh !== null) humPen = rh > 80 ? 0.85 : rh > 70 ? 0.92 : 1;
    }
    const p = clamp(100 * comfort * humPen, 2, 98);
    const quality = (at <= 26 && (rh === null || rh <= 70)) ? '优' : at <= 28 ? '良' : at <= 31 ? '一般' : '较弱';
    return { p, quality, window: '白天', parts: { atMax: Math.round(at), rh: rh === null ? null : Math.round(rh) } };
  }

  // 避寒：夜间体感 ≥12℃ 温暖概率；仅 11–3 月有意义
  function calcWarm(wx, d, dateStr) {
    const month = dateStr ? +dateStr.slice(5, 7) : null;
    if (month !== null && ![11, 12, 1, 2, 3].includes(month)) {
      return { p: null, quality: null, window: null, offSeason: true, parts: {} };
    }
    const at = wx.daily.apparent_temperature_min[d] ?? -99;
    const comfort = at >= 18 ? 1 : at >= 16 ? 0.9 : at >= 14 ? 0.75 : at >= 12 ? 0.6 : at >= 10 ? 0.35 : at >= 8 ? 0.15 : 0.05;
    const p = clamp(100 * comfort, 2, 98);
    const quality = at >= 16 ? '优' : at >= 14 ? '良' : at >= 12 ? '一般' : '较弱';
    return { p, quality, window: '全天', parts: { atMin: Math.round(at) } };
  }

  // 朝霞/晚霞：日出/日落 ±45 分钟窗口内 中低云散状覆盖 + 能见度 + 干燥
  function calcGlow(wx, d) {
    const sr = parseHM(wx.daily.sunrise[d]), ss = parseHM(wx.daily.sunset[d]);
    const pprob = wx.daily.precipitation_probability_max[d] ?? 0;
    const dry = 1 - pprob / 100;
    const glowPeak = (sc) => sc === null ? 0.4 : sc <= 5 ? 0.05 : sc >= 95 ? 0.05 : (sc <= 50 ? 0.08 + 0.92 * (sc - 5) / 45 : 1 - 0.95 * (sc - 50) / 45);

    if (!wx.hourly) {
      const code = wx.daily.weather_code[d];
      const g = { 0: 0.5, 1: 0.8, 2: 0.72, 3: 0.45, 45: 0.25, 48: 0.2 }[code] ?? (SNOW_CODES.includes(code) ? 0.25 : (code >= 95 ? 0.1 : 0.15));
      const p = clamp(100 * (0.75 * g + 0.25 * dry), 2, 98);
      return { p, quality: g >= 0.7 ? '良' : g >= 0.4 ? '一般' : '较弱', window: ss ? `日落 ${fmtHM(ss)} 前后` : '日出日落', approx: true };
    }
    const evalWin = (center) => {
      if (!center) return { score: 0, scatter: null, vis: null };
      const from = center.h - 1 <= 0 ? 0 : center.h - 1, to = center.h + 1 >= 23 ? 23 : center.h + 1;
      const low = hMean(wx, d, from, to, 'cloud_cover_low');
      const mid = hMean(wx, d, from, to, 'cloud_cover_mid');
      const vis = hMean(wx, d, from, to, 'visibility');
      const scatter = (low === null || mid === null) ? null : 100 * (1 - (1 - low / 100) * (1 - mid / 100));
      const visS = vis === null ? 0.7 : clamp((vis - 5) / 15, 0.05, 1);
      const score = 0.6 * glowPeak(scatter) + 0.15 * visS + 0.25 * dry;
      return { score, scatter, vis };
    };
    const m = evalWin(sr), e = evalWin(ss);
    const evening = e.score >= m.score;
    const pick = evening ? e : m;
    const p = clamp(100 * pick.score, 2, 98);
    const quality = pick.score >= 0.75 ? '优' : pick.score >= 0.55 ? '良' : pick.score >= 0.35 ? '一般' : '较弱';
    const label = evening ? '晚霞' : '朝霞';
    const center = evening ? ss : sr;
    const window = center ? `${label} ${fmtHM(hmShift(center, -45))}–${fmtHM(hmShift(center, 45))}` : null;
    const winRange = center ? { from: hmShift(center, -45), to: hmShift(center, 45), label } : null;
    return { p, quality, window, winRange, parts: { scatter: pick.scatter === null ? null : Math.round(pick.scatter), vis: pick.vis === null ? null : Math.round(pick.vis) } };
  }

  // 观星：夜间(21–04)云量 + 月相 + 光污染（POI 静态分级）
  function calcStars(wx, d, lp, dateStr) {
    const mp = moon(dateStr);
    const dark = mp.illum <= 0.15 ? 1 : mp.illum <= 0.35 ? 0.7 : mp.illum <= 0.6 ? 0.4 : 0.15;
    const lpF = lp ? [1, 0.85, 0.65, 0.4, 0.2][lp - 1] : 0.6;
    let nightCloud = null;
    if (wx.hourly) {
      let sum = 0, n = 0;
      for (let h = 21; h <= 23; h++) { const v = hVal(wx, d, h, 'cloud_cover'); if (v !== null) { sum += v; n++; } }
      for (let h = 0; h <= 4; h++) { const v = hVal(wx, d + 1, h, 'cloud_cover'); if (v !== null) { sum += v; n++; } }
      nightCloud = n ? sum / n : null;
    }
    if (nightCloud === null) {
      const code = wx.daily.weather_code[d];
      nightCloud = { 0: 8, 1: 15, 2: 45, 3: 85, 45: 90, 48: 90 }[code] ?? 90;
    }
    const p = clamp(100 * (0.55 * (1 - nightCloud / 100) + 0.25 * dark + 0.2 * lpF), 2, 98);
    const quality = (nightCloud < 15 && lp <= 2) ? '优' : (nightCloud < 25 && lp <= 3) ? '良' : nightCloud < 45 ? '一般' : '较弱';
    return {
      p, quality, window: '21:00–次日 04:00',
      parts: { nightCloud: Math.round(nightCloud), moon: Math.round(mp.illum * 100) / 100, lp: lp || 3 },
    };
  }

  /** 主入口：计算某位置某天某景观（dateStr 为该日 ISO 日期，观星月相用） */
  function compute(wx, d, key, lp, dateStr) {
    switch (key) {
      case 'sunny': return calcSunny(wx, d);
      case 'snow': return calcSnow(wx, d);
      case 'cool': return calcCool(wx, d, dateStr);
      case 'warm': return calcWarm(wx, d, dateStr);
      case 'glow': return calcGlow(wx, d);
      case 'stars': return calcStars(wx, d, lp, dateStr);
      default: return null;
    }
  }
  function computeAll(wx, d, lp, dateStr) {
    const out = {};
    for (const k of Object.keys(LANDSCAPES)) out[k] = compute(wx, d, k, lp, dateStr);
    return out;
  }

  /* ---------- 导出 ---------- */
  global.WSModel = {
    LANDSCAPES, RINGS, WMO_TEXT, SNOW_CODES, QUALITY_ORDER,
    haversine, moon, credibility, clamp,
    compute, computeAll, probColor,
    parseHM, fmtHM, hVal,
  };
})(window);
