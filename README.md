# 追景地图 WeatherScout · 网页 Demo（PRD 里程碑 M1）

> 没有目的地也能出发——打开第 N 天的全国天气预报地图，按"想看的天气/景观"一键筛选，在点亮的区域里反选目的地。
> 本 Demo 对应 `PRD_全国天气预测地图_v1.md` 的 M1 里程碑，全部使用 **Open-Meteo 真实预报数据**。

## 在线访问（Cloudflare Pages）

- **Web 版**：https://weather-scout.pages.dev/
- **H5 版**：https://weather-scout.pages.dev/?mode=h5 （手机直接访问会自动适配，无需参数）
- **部署管线**：push 到 GitHub `main` 分支 → Cloudflare Pages 自动构建上线（约 1 分钟）
- **底图策略**：地图右上角可切换四种底图——**高德**（中文标注栅格）、**矢量·清晰 / 矢量·浅灰**（MapLibre GL + OpenFreeMap 真矢量瓦片）、**卫星**（Esri 影像）；高德瓦片加载失败时 4 秒后自动切 Esri 备用。注意：高德底图为 GCJ-02 坐标系（演示用途）；矢量与卫星底图为 WGS84，标记对位更精确。

## 本地使用

**双击 `index.html` 即可使用**（纯静态站点，无需服务器；Leaflet 已本地化）。

- 需要网络：底图瓦片（高德）与「刷新」按钮（Open-Meteo）；已内置的天气缓存离线可用（仅缺底图瓦片）。
- 「↻ 刷新」按钮：浏览器直连 `api.open-meteo.com` 实时重新抓取全部数据（约 5~15 秒）。

## 主流程（PRD 4.2）

`选日期 → 选景观 → 地图点亮 →（可选）设出发地+等时圈 → 浏览候选 → 点开详情 → 保存订阅 / 跳转导航`

默认场景：**第 7 天 + 下雪**（PRD 1.2）。

## 文件结构

```
weather-scout-demo/
├── index.html            入口（双击打开）
├── css/style.css         浅色主题样式
├── js/ws-model.js        景观概率模型（启发式，公式公开透明）
├── js/ws-app.js          UI / 地图 / 候选 / 详情 / 订阅 / 刷新
├── data/poi.json         种子数据（111 景区 + 64 城市，WGS84 近似坐标）
├── data/ws-data.js       ← build-cache.mjs 生成（种子数据注入）
├── data/ws-cache.js      ← build-cache.mjs 生成（Open-Meteo 真实抓取 + 抓取时间戳 + 请求模板）
├── tools/build-cache.mjs 数据抓取脚本：node tools/build-cache.mjs（可随时重跑刷新缓存）
├── vendor/leaflet/       Leaflet 1.9.4 本地副本
└── verification/         独立 Agent 核验报告与截图
```

## 数据说明

- **来源**：[Open-Meteo](https://open-meteo.com/)（免费非商业、CC BY 4.0 需署名），`timezone=Asia/Shanghai`，16 天逐日 + 逐小时。
- **抓取范围**：175 个 POI/城市（逐日+逐小时）+ 104 个陆地格点（3° 降采样，逐日）。陆地掩膜来自 echarts 中国边界 GeoJSON（npmmirror）。
- **缓存内含**：`generatedAt`（抓取时间）、`source.requestTemplate`（复现请求的 URL 模板）、逐位置原始 daily/hourly 数组，便于第三方核验。
- **核验方法**：任取页面上的位置/日期，用 `source.requestTemplate` 请求 Open-Meteo 官方 API 比对 weather_code、气温、降水概率、降雪量、日出日落等字段；概率可按「关于页」公开公式复算。
- **已知近似**（页面「数据说明」中亦有标注）：等时圈为直线距离×经验半径；格点用逐日近似判据（带 *）；光污染为静态 1–5 分级；月相算法误差 ±0.5 天；底图为 GCJ-02 偏移坐标系（生产阶段接合规授权底图）。可信度口径：第1–3天高 / 第4–7天中 / 第8–15天低（页面时间轴 D0–2 / D3–6 / D7–15，D0=今天）。

## 合规

依《气象法》，公众气象预报由气象台站统一发布。本页定位为**基于公开气象数据的出行参考/概率分析**，已注明数据来源，不冒充官方预报、不发布灾害预警。商用前需评估 Open-Meteo 商业授权与地图审图合规。
