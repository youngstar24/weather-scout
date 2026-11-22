/**
 * lib.mjs —— 核验公共工具：加载缓存 / 加载模型（window stub）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export function loadCache() {
  const s = fs.readFileSync(path.join(ROOT, 'data', 'ws-cache.js'), 'utf8');
  const i = s.indexOf('window.WS_CACHE');
  const start = s.indexOf('{', i), end = s.lastIndexOf('}') + 1;
  return JSON.parse(s.slice(start, end));
}
export function loadPoi() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'poi.json'), 'utf8'));
}
/** 以 window stub 方式加载 js/ws-model.js，返回 window.WSModel */
export function loadModel() {
  const fakeWindow = {};
  const code = fs.readFileSync(path.join(ROOT, 'js', 'ws-model.js'), 'utf8');
  new Function('window', code)(fakeWindow);
  return fakeWindow.WSModel;
}
/** locList：POI + 城市（与 ws-app.js 一致，城市 lp=5） */
export function locList(poiDoc) {
  const out = [];
  for (const p of poiDoc.pois) out.push({ ...p, kind: 'poi' });
  for (const c of poiDoc.cities) out.push({ ...c, kind: 'city', lp: 5, tags: [] });
  return out;
}
export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
