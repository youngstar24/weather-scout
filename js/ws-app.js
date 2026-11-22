/**
 * ws-app.js —— 追景地图 WeatherScout 主应用（Demo / M1）
 * 依赖：Leaflet（vendor/leaflet）、data/ws-data.js、data/ws-cache.js、js/ws-model.js
 */
(function () {
  'use strict';

  const M = window.WSModel;
  const C = window.WS_CACHE;
  const D = window.WS_DATA;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ================= 状态 ================= */
  const S = {
    d: 7,                                    // 默认第 7 天（PRD 主场景）
    lands: new Set(['snow']),                // 默认景观：下雪（PRD 主场景）
    thr: 50,
    quals: new Set(M.QUALITY_ORDER),
    origin: 'city-beijing',
    rings: new Set(),
    sort: 'prob',
    subs: [],
    refreshing: false,
    drawerLoc: null,
  };
  try { S.subs = JSON.parse(localStorage.getItem('wsSubs') || '[]'); } catch (e) { S.subs = []; }

  /* ================= 数据访问 ================= */
  const dailyTime = C.dailyTime;           // 16 个 ISO 日期
  const hourlyTime = C.hourlyTime;         // 384 个 ISO 小时

  function wxOf(id) { return C.wx[id]; }

  /** 候选位置（POI + 城市），带静态信息 */
  function locList() {
    const out = [];
    for (const p of D.pois) out.push({ ...p, kind: 'poi' });
    for (const c of D.cities) out.push({ ...c, kind: 'city', lp: 5, tags: [] });
    return out.filter(l => wxOf(l.id));
  }
  function gridList() {
    return C.grid.filter(g => g.land && wxOf(g.id));
  }
  function originLoc() { return locList().find(l => l.id === S.origin) || locList()[0]; }

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function dayLabel(d) {
    const dt = new Date(dailyTime[d] + 'T12:00:00Z');
    return { date: `${dt.getUTCMonth() + 1}.${String(dt.getUTCDate()).padStart(2, '0')}`, week: WEEKDAYS[dt.getUTCDay()] };
  }

  /* ================= 计算 ================= */
  function computeAll(loc, d) { return M.computeAll(wxOf(loc.id), d, loc.lp, dailyTime[d]); }
  function maxP(res, lands) {
    let best = null;
    for (const k of lands) {
      const r = res[k];
      if (r && (best === null || r.p > best.p)) best = { key: k, ...r };
    }
    return best;
  }
  function distanceKm(loc) {
    const o = originLoc();
    return M.haversine(o.lat, o.lon, loc.lat, loc.lon);
  }
  function ringLabel(km) {
    const sel = M.RINGS.filter(r => S.rings.has(r.id));
    if (!sel.length) return null;
    const hit = sel.filter(r => km <= r.km).sort((a, b) => a.km - b.km)[0];
    return hit ? `${hit.mode}${hit.hours}h圈内` : null;
  }
  function candidates() {
    const list = locList().map(loc => {
      const res = computeAll(loc, S.d);
      const best = maxP(res, [...S.lands]);
      return { loc, res, best, km: distanceKm(loc), ring: ringLabel(distanceKm(loc)) };
    });
    let hits = list.filter(x => x.best && x.best.p >= S.thr && S.quals.has(x.best.quality));
    if (S.rings.size) hits = hits.filter(x => x.ring);
    const qRank = q => M.QUALITY_ORDER.indexOf(q);
    if (S.sort === 'prob') hits.sort((a, b) => b.best.p - a.best.p);
    else if (S.sort === 'dist') hits.sort((a, b) => a.km - b.km);
    else if (S.sort === 'quality') hits.sort((a, b) => (qRank(b.best.quality) - qRank(a.best.quality)) || (b.best.p - a.best.p));
    return hits;
  }

  /* ================= 地图 ================= */
  let map, layerGrid, layerLocs, layerRings, markersById = {};
  function initMap() {
    map = L.map('map', {
      center: [35.2, 104.5], zoom: 4, minZoom: 4, maxZoom: 11,
      maxBounds: [[13, 68], [57, 141]], maxBoundsViscosity: 0.8,
      attributionControl: false, zoomControl: true,
    });
    L.control.attribution({ prefix: false })
      .addAttribution('底图 © 高德地图（演示，GCJ-02）· 数据 © <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>')
      .addTo(map);
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: '1234', maxZoom: 11,
    }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    layerRings = L.layerGroup().addTo(map);
    layerGrid = L.layerGroup().addTo(map);
    layerLocs = L.layerGroup().addTo(map);
  }

  function drawRings() {
    layerRings.clearLayers();
    const o = originLoc();
    for (const r of M.RINGS) {
      if (!S.rings.has(r.id)) continue;
      L.circle([o.lat, o.lon], {
        radius: r.km * 1000, color: '#5a8fd6', weight: 1.2, dashArray: '7 6', fillOpacity: 0.03,
      }).bindTooltip(`${r.mode} ${r.hours}h ≈ ${r.km}km（直线近似）`, { sticky: true }).addTo(layerRings);
    }
  }

  function drawMap() {
    layerGrid.clearLayers();
    layerLocs.clearLayers();
    markersById = {};
    const cred = M.credibility(S.d);
    const lands = [...S.lands];

    // 网格层（仅陆地格点；逐日近似模型）
    for (const g of gridList()) {
      const wx = wxOf(g.id);
      const res = {};
      let best = null;
      for (const k of lands) {
        const r = M.compute(wx, S.d, k, null, dailyTime[S.d]);
        res[k] = r;
        if (r && (!best || r.p > best.p)) best = { key: k, ...r };
      }
      const lit = best && best.p >= S.thr;
      const col = lit ? M.probColor(best.p) : '#cfd4d9';
      const m = L.circleMarker([g.lat, g.lon], {
        radius: lit ? 15 : 6, fillColor: col, fillOpacity: lit ? cred.opacity : 0.28,
        stroke: lit && S.d >= 7, color: '#ffffff', weight: 1, dashArray: S.d >= 7 ? '4 4' : null,
      });
      const tipLines = lands.length
        ? lands.map(k => `${M.LANDSCAPES[k].icon} ${M.LANDSCAPES[k].name} <b>${res[k] ? Math.round(res[k].p) : '—'}%</b>（格点近似）`).join('<br>')
        : '未选择景观';
      m.bindTooltip(`格点 ${g.lon}°E ${g.lat}°N<br>${tipLines}`, { sticky: true });
      m.addTo(layerGrid);
    }

    // POI / 城市层
    for (const loc of locList()) {
      const res = computeAll(loc, S.d);
      const best = maxP(res, lands);
      const lit = best && best.p >= S.thr;
      const col = lit ? M.probColor(best.p) : '#b9c0c7';
      const m = L.circleMarker([loc.lat, loc.lon], {
        radius: loc.kind === 'poi' ? (lit ? 9 : 6) : (lit ? 7 : 5),
        fillColor: lit ? col : '#dde2e7', fillOpacity: 0.95,
        color: '#ffffff', weight: 1.5,
      });
      const tip = best
        ? `${M.LANDSCAPES[best.key].icon} <b>${esc(loc.name)}</b>（${esc(loc.prov)}）<br>${M.LANDSCAPES[best.key].name} <b>${Math.round(best.p)}%</b> · ${best.quality} · 可信度${M.credibility(S.d).level}`
        : `<b>${esc(loc.name)}</b>（${esc(loc.prov)}）`;
      m.bindTooltip(tip, { direction: 'top' });
      m.on('click', () => openDetail(loc));
      m.addTo(layerLocs);
      markersById[loc.id] = m;
    }
  }

  function renderLegend() {
    const lands = [...S.lands].map(k => M.LANDSCAPES[k]);
    const cred = M.credibility(S.d);
    $('#legend').innerHTML = `
      <div class="lg-row"><span class="lg-bar"></span><span>0%</span><span>50%</span><span>100%</span></div>
      <div class="lg-row small">阈值 ${S.thr}% 以下置灰 · 圆点越大/颜色越深概率越高</div>
      <div class="lg-row small">可信度：<b style="color:${cred.color}">${cred.level}</b>（${S.d <= 2 ? 'D0–2' : S.d <= 6 ? 'D3–6' : 'D7–15'}，时效越远越弱）</div>
      ${lands.length ? `<div class="lg-row small">已选：${lands.map(l => `${l.icon}${l.name}`).join(' · ')}</div>` : '<div class="lg-row small">点击上方景观标签点亮地图</div>'}`;
  }

  /* ================= 筛选面板 ================= */
  function renderChips() {
    $('#landChips').innerHTML = Object.values(M.LANDSCAPES).map(l => `
      <button class="chip ${S.lands.has(l.key) ? 'on' : ''}" data-key="${l.key}" title="${esc(l.hint)}">
        <span>${l.icon}</span>${l.name}
      </button>`).join('');
    $('#landChips').querySelectorAll('.chip').forEach(b => {
      b.addEventListener('click', () => {
        const k = b.dataset.key;
        if (S.lands.has(k)) S.lands.delete(k); else S.lands.add(k);
        update();
      });
    });
    $('#qualChips').innerHTML = M.QUALITY_ORDER.map(q => `
      <button class="chip sm ${S.quals.has(q) ? 'on' : ''}" data-q="${q}">${q}</button>`).join('');
    $('#qualChips').querySelectorAll('.chip').forEach(b => {
      b.addEventListener('click', () => {
        const q = b.dataset.q;
        if (S.quals.has(q)) S.quals.delete(q); else S.quals.add(q);
        update();
      });
    });
  }

  function renderDateAxis() {
    $('#dateAxis').innerHTML = dailyTime.map((t, d) => {
      const lb = dayLabel(d);
      const cred = M.credibility(d);
      return `<button class="day ${d === S.d ? 'on' : ''}" data-d="${d}" title="预报可信度：${cred.level}">
        <span class="dl">${lb.date}</span><span class="dw">${lb.week}</span>
        <span class="dot" style="background:${cred.color}"></span>
        <span class="dd">D${d}</span></button>`;
    }).join('');
    $('#dateAxis').querySelectorAll('.day').forEach(b => {
      b.addEventListener('click', () => { S.d = +b.dataset.d; update(); });
    });
    $('#dateAxis').querySelector(`.day[data-d="${S.d}"]`).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderOrigin() {
    const sel = $('#originSel');
    sel.innerHTML = D.cities.map(c => `<option value="${c.id}" ${c.id === S.origin ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    sel.addEventListener('change', () => { S.origin = sel.value; update(); });
    const box = $('#ringChecks');
    box.innerHTML = M.RINGS.map(r => `
      <label class="ring-item"><input type="checkbox" value="${r.id}" ${S.rings.has(r.id) ? 'checked' : ''}/>
      ${r.mode}${r.hours}h <span class="muted">≈${r.km}km</span></label>`).join('');
    box.querySelectorAll('input').forEach(i => {
      i.addEventListener('change', () => {
        if (i.checked) S.rings.add(i.value); else S.rings.delete(i.value);
        update();
      });
    });
  }

  /* ================= 候选列表 ================= */
  function renderCandidates() {
    const hits = candidates();
    $('#candCount').textContent = `${hits.length} / ${locList().length}`;
    const landsTxt = [...S.lands].map(k => M.LANDSCAPES[k].icon).join('') || '—';
    $('#candHint').textContent = `${landsTxt} ≥${S.thr}%`;

    const wrap = $('#candList');
    const empty = $('#emptyState');
    if (!hits.length) {
      wrap.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    wrap.innerHTML = hits.slice(0, 60).map(x => {
      const l = x.loc, b = x.best, ls = M.LANDSCAPES[b.key], cred = M.credibility(S.d);
      const others = Object.keys(x.res).filter(k => k !== b.key && S.lands.has(k) && x.res[k])
        .map(k => `<span class="mini">${M.LANDSCAPES[k].icon}${Math.round(x.res[k].p)}%</span>`).join('');
      return `<div class="card" data-id="${l.id}">
        <div class="card-top">
          <span class="card-name">${ls.icon} ${esc(l.name)}</span>
          <span class="card-p" style="background:${M.probColor(b.p)}">${Math.round(b.p)}%</span>
        </div>
        <div class="card-sub">${esc(l.prov)} · ${ls.name} · 质量 <b>${b.quality}</b> · 可信度 <b style="color:${cred.color}">${cred.level}</b></div>
        <div class="card-sub">${b.window ? '⏱ ' + esc(b.window) : ''}${b.approx ? ' <span class="mini">格点近似</span>' : ''}</div>
        <div class="card-sub muted">海拔≈${Math.round((wxOf(l.id).elev ?? l.elev))}m${x.ring ? ' · <b>' + x.ring + '</b>' : ''} · ${Math.round(x.km)}km</div>
        ${others ? `<div class="card-sub">${others}</div>` : ''}
        ${l.tags && l.tags.length ? `<div class="card-tags">${l.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    wrap.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => {
        const loc = locList().find(l => l.id === el.dataset.id);
        if (loc) openDetail(loc);
      });
    });
  }

  function renderEmpty() {
    const empty = $('#emptyState');
    if (!empty.hidden) {
      empty.innerHTML = `
        <p>没有符合条件的目的地。试试：</p>
        <button class="chip" data-act="thr">放宽概率阈值</button>
        <button class="chip" data-act="ring">扩大等时圈</button>
        <button class="chip" data-act="land">换一个景观</button>`;
      empty.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.act === 'thr') { S.thr = Math.max(10, S.thr - 20); $('#threshold').value = S.thr; $('#thresholdVal').textContent = S.thr + '%'; }
        if (b.dataset.act === 'ring') { const r = M.RINGS.find(x => x.km >= 320); S.rings.add(r.id); renderOrigin(); $('#ringBox').open = true; }
        if (b.dataset.act === 'land') { S.lands = new Set(['sunny']); }
        update();
      }));
    }
  }

  /* ================= 详情抽屉 ================= */
  function openDetail(loc) {
    S.drawerLoc = loc;
    const wx = wxOf(loc.id);
    const d = S.d;
    const res = computeAll(loc, d);
    const ls = [...S.lands][0] || 'sunny';
    const code = wx.daily.weather_code[d];

    const rows = Object.values(M.LANDSCAPES).map(l => {
      const r = res[l.key];
      const on = S.lands.has(l.key);
      const off = r.offSeason;
      const lowP = !off && r.p != null && r.p < 25;
      const pCell = off || r.p == null ? '—'
        : `<div class="pbar"><i style="width:${Math.round(r.p)}%;background:${M.probColor(r.p)}"></i></div>`;
      const pctCell = off || r.p == null ? '—' : `<b>${Math.round(r.p)}%</b>`;
      const qCell = off ? '<span class="muted">非当季</span>' : lowP ? '<span class="muted">—</span>' : r.quality;
      const wCell = off ? '<span class="muted">非当季</span>' : `${r.window ? esc(r.window) : '—'}${r.approx ? '*' : ''}`;
      return `<tr class="${on ? 'on' : ''}" data-key="${l.key}">
        <td>${l.icon} ${l.name}</td>
        <td>${pCell}</td>
        <td>${pctCell}</td>
        <td>${qCell}</td>
        <td class="muted">${wCell}</td>
      </tr>`;
    }).join('');

    $('#drawerBody').innerHTML = `
      <div class="dr-head">
        <div>
          <div class="dr-title">${esc(loc.name)} <span class="muted">${esc(loc.prov)} · ${loc.kind === 'poi' ? '景区' : '城市'}</span></div>
          <div class="dr-sub">${dayLabel(d).date} ${dayLabel(d).week}（D${d}）· 现象：${M.WMO_TEXT[code] || '—'} · 海拔≈${Math.round(wx.elev ?? loc.elev)}m · ${loc.lat.toFixed(2)}°N ${loc.lon.toFixed(2)}°E
          ${loc.lp ? ' · 光污染等级 <b>' + loc.lp + '</b>/5' : ''}</div>
          ${loc.tags && loc.tags.length ? `<div class="card-tags">${loc.tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
        <button class="icon-btn" id="drClose">✕</button>
      </div>
      <table class="dr-table"><thead><tr><th>景观</th><th style="width:34%">发生概率</th><th>%</th><th title="观赏质量=若该景观发生时的观感分级（如降雪量、色彩潜力），≠发生概率；概率<25% 时显示 —；避暑仅 5–9 月、避寒仅 11–3 月有意义">观赏质量 ⓘ</th><th>最佳时段</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="dr-note">* 网格近似值（无逐小时数据的格点）。点击行可切换筛选景观。观赏质量是"发生了好不好看"，与"发生概率"相互独立。</div>
      <div class="dr-sec"><h4>16 天概率曲线（选中景观）</h4><div id="drCurves"></div></div>
      <div class="dr-sec"><h4>${dayLabel(d).date} 逐小时预报（气温 / 降水概率 / 云量）</h4><div id="drHourly"></div></div>
      <div class="dr-actions">
        <button class="chip" id="drSub">🔔 用当前条件订阅此地</button>
        <a class="chip link" target="_blank" rel="noopener" href="https://uri.amap.com/navigation?to=${loc.lon},${loc.lat},${encodeURIComponent(loc.name)}&mode=car&policy=1&src=weatherscout&callnative=0">🧭 高德导航</a>
        <a class="chip link" target="_blank" rel="noopener" href="https://api.map.baidu.com/marker?location=${loc.lat},${loc.lon}&title=${encodeURIComponent(loc.name)}&content=${encodeURIComponent(loc.name)}&output=html&src=weatherscout">📍 百度地图</a>
        <a class="chip link" target="_blank" rel="noopener" href="https://www.baidu.com/s?wd=${encodeURIComponent(loc.name + ' 攻略 门票')}">🔎 攻略/门票</a>
        <a class="chip link" target="_blank" rel="noopener" href="https://www.12306.cn/index/">🚄 12306 购票</a>
      </div>`;
    $('#drawer').classList.add('open');
    $('#drClose').addEventListener('click', closeDetail);
    $('#drSub').addEventListener('click', () => {
      addSub({ lands: [...S.lands], origin: S.origin, rings: [...S.rings], from: S.d, to: S.d, thr: S.thr, note: loc.name });
      toast('已保存订阅（本地演示）');
      renderSubs();
    });
    $('#drawerBody').querySelectorAll('.dr-table tr[data-key]').forEach(tr => {
      tr.addEventListener('click', () => {
        const k = tr.dataset.key;
        S.lands = new Set([k]);
        renderChips(); update(); openDetail(loc);
      });
    });
    renderCurves(loc, ls);
    renderHourly(loc, d, res);
  }

  function closeDetail() { $('#drawer').classList.remove('open'); S.drawerLoc = null; }

  function renderCurves(loc, key) {
    const wx = wxOf(loc.id);
    const l = M.LANDSCAPES[key];
    const vals = [];
    for (let d = 0; d < 16; d++) vals.push(M.compute(wx, d, key, loc.lp, dailyTime[d]));
    if (vals.every(r => !r || r.p == null)) {
      $('#drCurves').innerHTML = `<p class="muted">该景观在此季节不适用（避暑仅 5–9 月 / 避寒仅 11–3 月），无曲线。可切换其他景观查看。</p>`;
      return;
    }
    const W = 520, H = 128, pad = 8;
    const x = i => pad + i * (W - 2 * pad) / 15;
    const y = v => H - 26 - (v / 100) * (H - 40);
    // 可信度背景带
    const band = (d0, d1, c) => `<rect x="${x(d0)}" y="4" width="${x(d1) - x(d0)}" height="${H - 30}" fill="${c}" opacity="0.10"/>`;
    // 折线段（跳过 null）
    const segs = [];
    let cur = [];
    vals.forEach((r, i) => {
      if (r && r.p != null) cur.push([i, r.p]);
      else { if (cur.length) segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    const polys = segs.map(seg => `<polyline points="${seg.map(([i, v]) => `${x(i)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${l.color}" stroke-width="2"/>`).join('');
    const dots = vals.map((r, i) => (r && r.p != null)
      ? `<circle cx="${x(i)}" cy="${y(r.p).toFixed(1)}" r="2.8" fill="${M.probColor(r.p)}"><title>D${i} ${dayLabel(i).date}（${dayLabel(i).week}）：发生概率 ${Math.round(r.p)}% · 观赏质量${r.quality} · 可信度${M.credibility(i).level}</title></circle>`
      : '').join('');
    // 每个点的概率数值
    const vlabels = vals.map((r, i) => (r && r.p != null)
      ? `<text x="${x(i)}" y="${(y(r.p) - 5).toFixed(1)}" font-size="8.5" fill="#4a5568" text-anchor="middle" font-weight="600">${Math.round(r.p)}</text>`
      : '').join('');
    const xlabels = [0, 3, 6, 9, 12, 15].map(i => `<text x="${x(i)}" y="${H - 12}" font-size="9" fill="#8a929b" text-anchor="middle">${dayLabel(i).date} D${i}</text>`).join('');
    // 选中日竖线
    const selR = vals[S.d];
    const selMark = (selR && selR.p != null)
      ? `<line x1="${x(S.d)}" y1="4" x2="${x(S.d)}" y2="${H - 30}" stroke="#2b6cb0" stroke-dasharray="3 3" stroke-width="1"/><text x="${x(S.d)}" y="${H - 2}" font-size="9" fill="#2b6cb0" font-weight="700" text-anchor="middle">选中：${Math.round(selR.p)}%</text>`
      : '';
    $('#drCurves').innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%">
      ${band(0, 2, '#2e9e6b')}${band(2, 6, '#e0a020')}${band(6, 15, '#d64550')}
      ${polys}${dots}${vlabels}${selMark}${xlabels}
      <text x="${x(1)}" y="14" font-size="9" fill="#2e9e6b">可信度高</text>
      <text x="${x(4.5)}" y="14" font-size="9" fill="#e0a020">中</text>
      <text x="${x(10)}" y="14" font-size="9" fill="#d64550">低（仅趋势）</text>
    </svg>
    <div class="dr-note" style="margin:4px 0 0">背景分区=预报可信度：<b>绿 D0–2 高</b>（近3天，数值较可信）→ <b>黄 D3–6 中</b> → <b>红 D7–15 低（仅趋势参考，越远变数越大，出发前请再看临近预报）</b>。每个点上方的数字就是当天的发生概率（%），悬停数据点可看质量与可信度详情。</div>`;
  }

  function renderHourly(loc, d, res) {
    const wx = wxOf(loc.id);
    const W = 740, H = 190, padL = 30, step = (W - padL - 10) / 24;
    const temps = [], pprobs = [], clouds = [], lms = [], sfArr = [];
    for (let h = 0; h < 24; h++) {
      temps.push(M.hVal(wx, d, h, 'temperature_2m'));
      pprobs.push(M.hVal(wx, d, h, 'precipitation_probability'));
      clouds.push(M.hVal(wx, d, h, 'cloud_cover'));
      const lo = M.hVal(wx, d, h, 'cloud_cover_low'), mi = M.hVal(wx, d, h, 'cloud_cover_mid');
      lms.push(lo === null || mi === null ? null : Math.min(100, lo + mi));
      sfArr.push(M.hVal(wx, d, h, 'snowfall') ?? 0);
    }
    const tvals = temps.filter(v => v !== null);
    if (!tvals.length) { $('#drHourly').innerHTML = '<p class="muted">该位置无逐小时数据（格点近似）。</p>'; return; }
    const tmin = Math.floor(Math.min(...tvals)), tmax = Math.ceil(Math.max(...tvals));
    const ty = v => 46 - (v - tmin) / Math.max(1, tmax - tmin) * 30;           // 温度带 16..46
    const py = v => 150 - (v / 100) * 44;                                       // 概率/云量带 106..150
    const px = i => padL + i * step + step / 2;
    const line = arr => arr.map((v, i) => v === null ? '' : `${px(i)},${v}`).filter(Boolean).join(' ');

    const bars = pprobs.map((v, i) => v === null ? '' :
      `<rect x="${px(i) - step * 0.32}" y="${py(v)}" width="${step * 0.64}" height="${150 - py(v)}" fill="#4f9dde" opacity="0.35"/>`).join('');
    const cloudLine = `<polyline points="${line(clouds.map(v => v === null ? null : py(v)))}" fill="none" stroke="#9aa3ad" stroke-width="1.6"/>`;
    const lmLine = `<polyline points="${line(lms.map(v => v === null ? null : py(v)))}" fill="none" stroke="#6f5bd6" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    const tempLine = `<polyline points="${line(temps.map(v => v === null ? null : ty(v)))}" fill="none" stroke="#ef6c2e" stroke-width="2"/>`;
    const snows = [];
    for (let h = 0; h < 24; h++) { const sf = M.hVal(wx, d, h, 'snowfall'); if (sf !== null && sf > 0.05) snows.push(`<text x="${px(h)}" y="14" font-size="11" text-anchor="middle">❄</text>`); }
    const sr = M.parseHM(wx.daily.sunrise[d]), ss = M.parseHM(wx.daily.sunset[d]);
    const vline = (hm, c) => hm ? `<line x1="${px(hm.h)}" y1="18" x2="${px(hm.h)}" y2="150" stroke="${c}" stroke-dasharray="3 4" stroke-width="1"/>` : '';
    // 窗口高亮
    let shades = '';
    const snowWin = res.snow && res.snow.winHours;
    if (snowWin) shades += `<rect x="${px(snowWin[0]) - step * 0.4}" y="18" width="${(snowWin[1] - snowWin[0] + 1) * step * 0.8 + step * 0.4}" height="132" fill="#3f8ecb" opacity="0.12"/>`;
    const glowWin = res.glow && res.glow.winRange;
    if (glowWin) {
      const from = glowWin.from.h + glowWin.from.m / 60, to = glowWin.to.h + glowWin.to.m / 60;
      shades += `<rect x="${px(Math.floor(from))}" y="18" width="${Math.max(step, (to - from) * step)}" height="132" fill="#ef6da8" opacity="0.12"/>`;
    }
    const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21].map(h =>
      `<text x="${px(h)}" y="166" font-size="9" fill="#8a929b" text-anchor="middle">${String(h).padStart(2, '0')}时</text>`).join('');
    // 图上直接标注数值（每 2 小时）
    const tempLabels = temps.map((v, i) => (v !== null && i % 2 === 0)
      ? `<text x="${px(i)}" y="${(ty(v) + 12).toFixed(1)}" font-size="8.5" fill="#ef6c2e" text-anchor="middle" font-weight="700">${Math.round(v)}°</text>` : '').join('');
    const ppLabels = pprobs.map((v, i) => (v !== null && i % 2 === 0)
      ? `<text x="${px(i)}" y="160" font-size="8.5" fill="#2f7fc0" text-anchor="middle" font-weight="700">${Math.round(v)}</text>` : '').join('');
    // 每小时悬停提示（透明命中区）
    const hits = [];
    for (let h = 0; h < 24; h++) {
      const fmt = (v, u, d2 = 0) => v === null || v === undefined ? '—' : Number(v).toFixed(d2) + u;
      hits.push(`<rect x="${padL + h * step}" y="10" width="${step}" height="146" fill="transparent"><title>${String(h).padStart(2, '0')}时：气温 ${fmt(temps[h], '℃', 1)} · 降水概率 ${fmt(pprobs[h], '%')} · 总云量 ${fmt(clouds[h], '%')} · 低+中云 ${fmt(lms[h], '%')}${(sfArr[h] ?? 0) > 0.05 ? ' · 降雪 ' + sfArr[h].toFixed(1) + 'cm' : ''}</title></rect>`);
    }
    const legend = `<div class="hr-legend">
      <span><i style="background:#ef6c2e"></i><b>橙线</b>=气温（℃）</span>
      <span><i style="background:#4f9dde"></i><b>蓝柱</b>=降水概率（%）</span>
      <span><i style="background:#9aa3ad"></i><b>灰线</b>=总云量（%）</span>
      <span><i style="background:#6f5bd6"></i><b>紫虚线</b>=低+中云量（%）</span>
      <span>❄=该小时有降雪</span>
      <span class="muted">· 图上每 2 小时标数值，下方附完整数值表</span>
    </div>`;
    // 每小时数值表（与图同宽、横向同步滚动）
    const cell = v => v === null || v === undefined ? '—' : v;
    const hrRow = (label, arr, fmt) => `<tr><th>${label}</th>${arr.map(v => `<td>${cell(v === null ? null : fmt(v))}</td>`).join('')}</tr>`;
    const hrTable = `<table class="hr-table">
      <tr><th>时刻</th>${Array.from({ length: 24 }, (_, h) => `<td>${String(h).padStart(2, '0')}</td>`).join('')}</tr>
      ${hrRow('气温 ℃', temps, v => v.toFixed(1))}
      ${hrRow('降水概率 %', pprobs, v => Math.round(v))}
      ${hrRow('总云量 %', clouds, v => Math.round(v))}
      ${hrRow('低+中云 %', lms, v => Math.round(v))}
      ${hrRow('降雪 cm/h', sfArr, v => v.toFixed(1))}
    </table>`;
    $('#drHourly').innerHTML = `${legend}<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:${W}px;min-width:100%">
      ${shades}${bars}${vline(sr, '#e0a020')}${vline(ss, '#d64550')}${cloudLine}${lmLine}${tempLine}${snows}${hourLabels}${tempLabels}${ppLabels}${hits}
      <text x="4" y="40" font-size="9" fill="#ef6c2e">气温℃</text>
      <text x="4" y="104" font-size="9" fill="#4a5568">概率/云量 %</text>
    </svg>${hrTable}</div>`;
  }

  /* ================= 订阅（本地演示） ================= */
  function loadSubs() { try { return JSON.parse(localStorage.getItem('wsSubs') || '[]'); } catch (e) { return []; } }
  function saveSubs() { try { localStorage.setItem('wsSubs', JSON.stringify(S.subs)); } catch (e) { /* file:// 下可能受限 */ } }
  function addSub(s) {
    S.subs.push({ id: 'sub_' + Date.now(), created: new Date().toISOString(), ...s });
    saveSubs();
    $('#subCount').textContent = S.subs.length || '';
    evalSubs();
  }
  function evalSubs() {
    const o = originLoc();
    for (const sub of S.subs) {
      const origin = D.cities.find(c => c.id === sub.origin) || o;
      const maxKm = sub.rings && sub.rings.length ? Math.max(...M.RINGS.filter(r => sub.rings.includes(r.id)).map(r => r.km)) : 0;
      const hits = [];
      for (const loc of locList()) {
        if (maxKm > 0 && M.haversine(origin.lat, origin.lon, loc.lat, loc.lon) > maxKm) continue;
        let bestHit = null;
        for (let d = sub.from; d <= sub.to; d++) {
          const res = computeAll(loc, d);
          for (const k of sub.lands) {
            const r = res[k];
            if (r && r.p >= sub.thr && (!bestHit || r.p > bestHit.p)) bestHit = { key: k, p: r.p, d, quality: r.quality, window: r.window };
          }
        }
        if (bestHit) hits.push({ loc, bestHit });
      }
      hits.sort((a, b) => b.bestHit.p - a.bestHit.p);
      sub.hits = hits.slice(0, 30);
      sub.hitCount = hits.length;
    }
    saveSubs();
    $('#subCount').textContent = S.subs.filter(s => s.hitCount > 0).length || '';
    const total = S.subs.reduce((a, s) => a + (s.hitCount > 0 ? 1 : 0), 0);
    if (total) toast(`🔔 ${total} 个订阅条件今日有命中（点「订阅」查看）`);
  }
  function renderSubs() {
    const box = $('#subsList');
    if (!S.subs.length) { box.innerHTML = '<p class="muted">暂无订阅。在地图上选好「景观 + 日期 + 圈层」后，点候选卡或详情里的订阅按钮。</p>'; return; }
    box.innerHTML = S.subs.map(s => {
      const lands = s.lands.map(k => `${M.LANDSCAPES[k].icon}${M.LANDSCAPES[k].name}`).join('+');
      const origin = (D.cities.find(c => c.id === s.origin) || {}).name || '—';
      const top = (s.hits || []).slice(0, 3).map(h => `${esc(h.loc.name)} ${Math.round(h.bestHit.p)}%`).join(' · ');
      return `<div class="sub-item" data-id="${s.id}">
        <div class="sub-top"><b>${lands}</b> ${origin} 出发 · D${s.from}${s.to !== s.from ? '–D' + s.to : ''} · ≥${s.thr}% · ${s.rings && s.rings.length ? '有圈层' : '全国'}
        <button class="icon-btn del" data-id="${s.id}">🗑</button></div>
        <div class="sub-hit">${s.hitCount ? `命中 <b>${s.hitCount}</b> 个目的地：${top}` : '<span class="muted">当前数据无命中</span>'}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
      S.subs = S.subs.filter(x => x.id !== b.dataset.id);
      saveSubs(); $('#subCount').textContent = S.subs.filter(s => s.hitCount > 0).length || '';
      renderSubs();
    }));
  }
  function initSubModal() {
    const form = $('#subForm');
    form.innerHTML = `
      <label>景观（多选）</label>
      <div id="subLands">${Object.values(M.LANDSCAPES).map(l => `<label class="ring-item"><input type="checkbox" value="${l.key}" ${l.key === 'snow' ? 'checked' : ''}/>${l.icon}${l.name}</label>`).join('')}</div>
      <label>日期窗口（D0–D15）</label>
      <div class="row"><input type="number" id="subFrom" min="0" max="15" value="5"/> ~ <input type="number" id="subTo" min="0" max="15" value="7"/>
      <label class="ring-item">阈值 <input type="number" id="subThr" min="10" max="95" value="50"/>%</label></div>
      <label>出发地与圈层</label>
      <div class="row"><select id="subOrigin">${D.cities.map(c => `<option value="${c.id}" ${c.id === S.origin ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="subRing"><option value="">全国不限</option>${M.RINGS.map(r => `<option value="${r.id}">${r.mode}${r.hours}h ≈${r.km}km</option>`).join('')}</select></div>
      <button class="chip primary" id="subSave">保存订阅（本地演示）</button>`;
    $('#subSave').addEventListener('click', () => {
      const lands = [...form.querySelectorAll('#subLands input:checked')].map(i => i.value);
      if (!lands.length) { toast('请至少选择一个景观'); return; }
      addSub({
        lands, origin: $('#subOrigin').value,
        rings: $('#subRing').value ? [$('#subRing').value] : [],
        from: clampInt($('#subFrom').value, 0, 15), to: clampInt($('#subTo').value, 0, 15),
        thr: clampInt($('#subThr').value, 10, 95),
      });
      renderSubs();
      toast('已保存订阅（本地演示）');
    });
  }
  const clampInt = (v, a, b) => Math.min(b, Math.max(a, parseInt(v, 10) || a));

  /* ================= 关于 ================= */
  function initAbout() {
    $('#aboutBody').innerHTML = `
      <h3>这是什么</h3>
      <p>「追景地图 WeatherScout」Demo：没有目的地也能出发——选择日期与想看的天气/景观，在全国地图上按发生概率点亮区域，反向挑选目的地。本页为 PRD 里程碑 M1 的可交互原型，定位是<b>出行参考的概率分析工具</b>，非官方气象预报。</p>
      <h3>数据来源（真实抓取）</h3>
      <ul>
        <li>天气预报：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>（免费非商业、无需 Key，署名许可 <b>CC BY 4.0</b>，商用需向其购买授权），逐日 16 天 + 逐小时，时区 Asia/Shanghai；本页缓存生成于 <b>${esc((C.generatedAt || '').replace('T', ' ').slice(0, 16))} UTC</b>，可点右上角「刷新」实时重取。</li>
        <li>底图瓦片：高德地图（演示用途；坐标为 GCJ-02，与 WGS84 存在约数百米偏移，全国尺度下不影响判读）。生产阶段将接入合规授权底图。</li>
        <li>海拔：Open-Meteo 返回的模型地形海拔；光污染/景区类型：自建种子数据（静态分级，近似值）。</li>
      </ul>
      <h3>景观判据与概率公式（Demo 启发式版）</h3>
      <table class="dr-table about-tbl">
        <tr><th>景观</th><th>概率判据</th><th>观赏质量分级（发生了好不好看，≠发生概率）</th></tr>
        <tr><td>☀️ 晴朗蓝天</td><td>白天(09–16时)总云量、能见度、日降水概率加权：P=55%·(1−云量)+20%·能见度分+25%·(1−降水概率)</td><td>云量<15%且能见度≥18km 为优</td></tr>
        <tr><td>❄️ 下雪</td><td>P=日降水概率×雪相态概率；雪相态按日均温回退（≤-4℃≈0.95 / ≤-1℃≈0.88 / ≤1℃≈0.68 / ≤3℃≈0.4 / ≤5℃≈0.15 / >5℃≈0.03），有逐小时数据时改用降水时气温<1℃的占比（取两者较大者）；雪类天气码(71/73/75/77/85/86)保底 55%；降雪量≤0.05cm 减半；结果限 2–98%</td><td>按日降雪量：≥3cm 优 / ≥1cm 良 / ≥0.2cm 一般</td></tr>
        <tr><td>🌲 避暑</td><td>白天体感最高温舒适度映射（≤24℃=100%…≥34℃=3%）×湿度修正；<b>仅 5–9 月有效</b>，其他月份详情页显示「非当季」</td><td>体感≤26℃且湿度≤70% 为优</td></tr>
        <tr><td>🌴 避寒</td><td>夜间体感最低温映射（≥18℃=100%…≥12℃=60%，<8℃=5%）；<b>仅 11–3 月有效</b>，其他月份显示「非当季」</td><td>体感≥16℃ 为优</td></tr>
        <tr><td>🌇 朝霞晚霞</td><td>日出/日落 ±45min 窗口内低+中云散状覆盖（30–70% 最佳，峰值 50%）×60% + 能见度 15% + 干燥 25%</td><td>综合分 ≥0.75 为优</td></tr>
        <tr><td>✨ 观星</td><td>夜间(21–04时)云量 55% + 月相暗度 25% + 光污染系数 20%；月相暗度按月照度阶梯（≤15%=1.0 / ≤35%=0.7 / ≤60%=0.4 / >60%=0.15，简化周期算法误差 ±0.5 天）；光污染系数 1级暗夜=1.0 / 2级=0.85 / 3级=0.65 / 4级=0.4 / 5级城市=0.2（格点无属性取 0.6）</td><td>云量<15%且光污染≤2 为优</td></tr>
      </table>
      <p><b>关于「观赏质量」列</b>：它回答的是"<b>如果发生了，好不好看</b>"（例如降雪量越大雪景越壮观、能见度越高天空越透），与左侧的"发生概率"相互独立。分级为 <b>优 / 良 / 一般 / 较弱</b>；发生概率 &lt;25% 时该列显示 <b>—</b>（概率太低时谈质量没有意义）；避暑仅在 5–9 月、避寒仅在 11–3 月计算，其余月份显示「非当季」。</p>
      <h3>可信度（不确定性透明）</h3>
      <p>预报可信度随时效衰减：<b>第1–3天高 / 第4–7天中 / 第8–15天低（仅趋势）</b>，对应页面时间轴 <b>D0–2 高 / D3–6 中 / D7–15 低</b>（D0=今天）。地图点位随日期降低透明度并加虚线纹理，曲线图按可信度分区着色。</p>
      <h3>已知近似与局限</h3>
      <ul>
        <li>等时圈为<b>直线距离×经验半径</b>近似（自驾 70/150/240km、高铁 150/320/500km），未考虑实际路网/线路与换乘。</li>
        <li>无逐小时数据的格点使用逐日近似判据（带 * 号）；光污染为静态 1–5 分级；月相算法误差 ±0.5 天。</li>
        <li>概率为启发式估计，未引入集合预报离散度/多模型一致性（生产阶段引入）。</li>
      </ul>
      <h3>合规与免责</h3>
      <p>依《气象法》公众气象预报由气象台站统一发布；本页为基于公开气象数据的出行参考/概率分析，注明数据来源，不冒充官方预报，不发布灾害预警。数据仅供出行决策参考，据此出行风险自担。商用前需评估 Open-Meteo 商业授权与地图审图合规。</p>`;
  }

  /* ================= 刷新数据（客户端直连 Open-Meteo） ================= */
  const DAILY_VARS = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min', 'precipitation_probability_max', 'precipitation_sum', 'snowfall_sum', 'sunrise', 'sunset', 'uv_index_max'];
  const HOURLY_VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation_probability', 'snowfall', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'visibility'];

  async function refreshData() {
    if (S.refreshing) return;
    S.refreshing = true;
    const btn = $('#btnRefresh');
    btn.disabled = true; btn.textContent = '⏳ 抓取中…';
    try {
      const hourlyLocs = locList();
      const dailyLocs = [...hourlyLocs.map(l => ({ id: l.id, lat: l.lat, lon: l.lon })), ...gridList().map(g => ({ id: g.id, lat: g.lat, lon: g.lon }))];
      const common = `timezone=Asia%2FShanghai&forecast_days=16`;
      const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
      const newWx = {};
      const times = { daily: null, hourly: null };
      const fetchBatch = async (g, vars, withHourly) => {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${g.map(p => p.lat).join(',')}&longitude=${g.map(p => p.lon).join(',')}&daily=${DAILY_VARS.join(',')}${withHourly ? '&hourly=' + HOURLY_VARS.join(',') : ''}&${common}`;
        let data = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!data.ok) throw new Error('HTTP ' + data.status);
        data = await data.json();
        if (!Array.isArray(data)) data = [data];
        data.forEach((item, i) => {
          if (!times.daily && item.daily && item.daily.time) times.daily = item.daily.time;
          if (!times.hourly && item.hourly && item.hourly.time) times.hourly = item.hourly.time;
          const rec = { elev: item.elevation, daily: {} };
          for (const v of DAILY_VARS) rec.daily[v] = item.daily[v];
          if (withHourly && item.hourly) {
            rec.hourly = {};
            for (const v of HOURLY_VARS) rec.hourly[v] = item.hourly[v];
            rec.hourly.visibility = rec.hourly.visibility.map(v => v === null ? null : Math.round(v / 1000));
          }
          newWx[g[i].id] = rec;
        });
      };
      const runBatches = async (locs, withHourly) => {
        const groups = chunk(locs, withHourly ? 45 : 90);
        let next = 0;
        await Promise.all(Array.from({ length: 3 }, async () => {
          while (next < groups.length) { const gi = next++; await fetchBatch(groups[gi], null, withHourly); }
        }));
      };
      await runBatches(dailyLocs, false);
      await runBatches(hourlyLocs.map(l => ({ id: l.id, lat: l.lat, lon: l.lon })), true);
      C.wx = newWx;
      C.generatedAt = new Date().toISOString();
      if (times.daily) C.dailyTime = times.daily;
      if (times.hourly) C.hourlyTime = times.hourly;
      update();
      toast('✅ 已从 Open-Meteo 实时刷新全部数据');
    } catch (e) {
      console.warn('刷新失败', e);
      toast('⚠️ 刷新失败，仍显示最近缓存（' + e.message + '）');
    } finally {
      S.refreshing = false;
      btn.disabled = false; btn.textContent = '↻ 刷新';
    }
  }

  /* ================= Toast ================= */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  /* ================= 总刷新 ================= */
  function update() {
    renderChips();
    renderDateAxis();
    renderLegend();
    drawRings();
    drawMap();
    renderCandidates();
    renderEmpty();
    $('#dataStamp').textContent = `数据更新：${(C.generatedAt || '').replace('T', ' ').slice(0, 16)} UTC（Open-Meteo 真实抓取）`;
    if (S.drawerLoc && $('#drawer').classList.contains('open')) openDetail(S.drawerLoc);
  }

  /* ================= 移动端 tabs ================= */
  function initTabs() {
    const tabs = $('#mobileTabs');
    document.body.dataset.view = document.body.dataset.view || 'map';
    // ?mode=h5 或 #h5：强制 H5（手机）布局，桌面浏览器可预览；真手机由媒体查询自动生效
    const force = new URLSearchParams(location.search).get('mode') === 'h5' || location.hash === '#h5';
    if (force) document.body.classList.add('force-h5');
    tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.body.dataset.view = b.dataset.view;
    }));
  }

  /* ================= 启动 ================= */
  function init() {
    initMap();
    renderChips();
    renderOrigin();
    initSubModal();
    initAbout();
    initTabs();
    $('#threshold').addEventListener('input', e => {
      S.thr = +e.target.value;
      $('#thresholdVal').textContent = S.thr + '%';
      renderCandidates(); renderEmpty(); drawMap(); renderLegend();
    });
    $('#sortBy').addEventListener('change', e => { S.sort = e.target.value; renderCandidates(); });
    $('#btnRefresh').addEventListener('click', refreshData);
    $('#btnAbout').addEventListener('click', () => $('#modalAbout').classList.add('open'));
    $('#footAbout').addEventListener('click', () => $('#modalAbout').classList.add('open'));
    $('#btnSubs').addEventListener('click', () => { renderSubs(); $('#modalSubs').classList.add('open'); evalSubs(); renderSubs(); });
    document.querySelectorAll('.modal .close').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('open')));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));
    update();
    evalSubs();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
