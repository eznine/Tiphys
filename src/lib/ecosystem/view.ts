/** Shared map-view + custom basemap state so UI, importers and Agent tools agree on "current view". */
export type Bbox = [number, number, number, number];
let currentBounds: Bbox | null = null;
let currentCenter: { lng: number; lat: number; zoom: number } | null = null;

export function setCurrentMapView(bounds: Bbox, center: { lng: number; lat: number; zoom: number }) {
  currentBounds = bounds; currentCenter = center;
}
export function getCurrentBounds(): Bbox | null { return currentBounds; }
export function getCurrentCenter() { return currentCenter; }

/** Ask the map to fly somewhere (handled by MapCanvas). */
export function requestFlyTo(lng: number, lat: number, zoom = 14) {
  window.dispatchEvent(new CustomEvent("tiphys:flyto", { detail: { lng, lat, zoom } }));
}

export type CustomTileSource = { label: string; tiles: string[]; attribution: string };
const CUSTOM_KEY = "tiphys-custom-basemap";
export function readCustomBasemap(): CustomTileSource | null {
  try { const raw = localStorage.getItem(CUSTOM_KEY); return raw ? JSON.parse(raw) as CustomTileSource : null; } catch { return null; }
}
/** Store an online tile service as the "自定义" basemap and switch the map to it. */
export function useCustomBasemap(source: CustomTileSource) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(source));
  window.dispatchEvent(new CustomEvent("tiphys:basemap", { detail: { id: "custom", source } }));
}
export function switchBasemap(id: string) {
  window.dispatchEvent(new CustomEvent("tiphys:basemap", { detail: { id } }));
}

export function bboxArea([w, s, e, n]: Bbox) { return Math.abs(e - w) * Math.abs(n - s); }
export function locateMe(timeout = 12000): Promise<{ lng: number; lat: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("此设备不支持定位。")); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy }),
      err => reject(new Error(err.code === 1 ? "定位权限被拒绝，请在系统设置里允许 TIPHYS 使用位置。" : "定位失败，请到室外或稍后再试。")),
      { enableHighAccuracy: true, timeout, maximumAge: 60000 });
  });
}
export function bboxAround(lng: number, lat: number, km: number): Bbox {
  const dLat = km / 111.32, dLng = km / (111.32 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** Extract features already streamed by the vector-tile basemap (OpenFreeMap / OpenMapTiles schema). */
export type TileFeature = { type: "Feature"; properties: Record<string, any>; geometry: any };
type Extractor = (sourceLayers: string[], focus?: { lng: number; lat: number; zoom: number }) => Promise<{ features: TileFeature[]; zoom: number } | null>;
let extractor: Extractor | null = null;
export function setTileExtractor(fn: Extractor | null) { extractor = fn; }
export function getTileExtractor() { return extractor; }
