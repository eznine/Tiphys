/** Browser-side map export helpers kept separate from MapLibre for testability. */

export type PngCanvas = Pick<HTMLCanvasElement, "toDataURL">;

export const MAP_LAYOUT_PRESETS = [
  { id: "a4-landscape", label: "A4 横向", width: 1754, height: 1240 },
  { id: "a4-portrait", label: "A4 纵向", width: 1240, height: 1754 },
  { id: "square", label: "方形", width: 1400, height: 1400 },
] as const;

export type MapLayoutPresetId = typeof MAP_LAYOUT_PRESETS[number]["id"];
export type MapLayoutOptions = {
  preset: MapLayoutPresetId;
  title: string;
  subtitle?: string;
  includeDate?: boolean;
  theme?: "light" | "dark";
};

export type MapLayoutPreferences = Pick<MapLayoutOptions, "preset" | "title" | "subtitle" | "includeDate">;
export const MAP_LAYOUT_PREFERENCES_KEY = "tiphys-map-layout-preferences";
export const DEFAULT_MAP_LAYOUT_PREFERENCES: MapLayoutPreferences = {
  preset: "a4-landscape",
  title: "TIPHYS 地图",
  subtitle: "",
  includeDate: false,
};

export type MapLayoutRect = { x: number; y: number; width: number; height: number };
export type MapLayoutGeometry = {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  mapFrame: MapLayoutRect;
  image: MapLayoutRect;
};

/** The subset of CanvasRenderingContext2D used by the layout renderer. */
export type MapLayoutContext = {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  drawImage: (image: CanvasImageSource, dx: number, dy: number, dWidth: number, dHeight: number) => void;
  fillText: (text: string, x: number, y: number, maxWidth?: number) => void;
  measureText: (text: string) => Pick<TextMetrics, "width">;
};

export function mapPngDataUrl(canvas: PngCanvas): string {
  let dataUrl = "";
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    throw new Error("地图画布尚不可导出，请等待地图渲染完成后重试。");
  }
  if (!dataUrl.startsWith("data:image/png")) throw new Error("地图画布为空，请等待地图渲染完成后重试。");
  return dataUrl;
}

export function mapExportFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `tiphys-map-${stamp}.png`;
}

function downloadDataUrl(dataUrl: string, filename: string): string {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return filename;
}

export function downloadMapPng(canvas: PngCanvas, filename = mapExportFilename()): string {
  if (typeof document === "undefined") throw new Error("当前环境不支持浏览器下载。");
  return downloadDataUrl(mapPngDataUrl(canvas), filename);
}

export function mapLayoutFilename(preset: MapLayoutPresetId, now = new Date()): string {
  const stamp = mapExportFilename(now).slice("tiphys-map-".length, -".png".length);
  return `tiphys-layout-${preset}-${stamp}.png`;
}

export function mapLayoutPreset(id: MapLayoutPresetId) {
  const preset = MAP_LAYOUT_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`未知的布局尺寸：${id}`);
  return preset;
}

/** Fills missing or malformed saved layout fields from a known fallback. */
export function normalizeMapLayoutPreferences(raw: unknown, fallback: MapLayoutPreferences = DEFAULT_MAP_LAYOUT_PREFERENCES): MapLayoutPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
  const input = raw as Record<string, unknown>;
  const preset = MAP_LAYOUT_PRESETS.some(item => item.id === input.preset) ? input.preset as MapLayoutPresetId : fallback.preset;
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 80) || fallback.title : fallback.title;
  const subtitle = typeof input.subtitle === "string" ? input.subtitle.slice(0, 120) : fallback.subtitle;
  const includeDate = typeof input.includeDate === "boolean" ? input.includeDate : fallback.includeDate;
  return { preset, title, subtitle, includeDate };
}

export function parseMapLayoutPreferences(serialized: string | null, fallback: MapLayoutPreferences = DEFAULT_MAP_LAYOUT_PREFERENCES): MapLayoutPreferences {
  if (!serialized) return { ...fallback };
  try {
    return normalizeMapLayoutPreferences(JSON.parse(serialized), fallback);
  } catch {
    return { ...fallback };
  }
}

export function mapLayoutPreferences(options: MapLayoutOptions): MapLayoutPreferences {
  return { preset: options.preset, title: options.title, subtitle: options.subtitle ?? "", includeDate: options.includeDate === true };
}

export function fitMapLayoutRect(sourceWidth: number, sourceHeight: number, frame: MapLayoutRect): MapLayoutRect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error("地图画布尺寸无效，请等待地图渲染完成后重试。");
  const scale = Math.min(frame.width / sourceWidth, frame.height / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x: Math.round(frame.x + (frame.width - width) / 2),
    y: Math.round(frame.y + (frame.height - height) / 2),
    width,
    height,
  };
}

export function mapLayoutGeometry(presetId: MapLayoutPresetId, sourceWidth: number, sourceHeight: number): MapLayoutGeometry {
  const preset = mapLayoutPreset(presetId);
  const margin = Math.round(Math.min(preset.width, preset.height) * 0.04);
  const headerHeight = Math.round(preset.height * 0.12);
  const footerHeight = Math.round(preset.height * 0.055);
  const mapFrame = {
    x: margin,
    y: margin + headerHeight,
    width: preset.width - margin * 2,
    height: preset.height - margin * 2 - headerHeight - footerHeight,
  };
  return {
    pageWidth: preset.width,
    pageHeight: preset.height,
    margin,
    mapFrame,
    image: fitMapLayoutRect(sourceWidth, sourceHeight, mapFrame),
  };
}

function fittedText(ctx: MapLayoutContext, text: string, maxWidth: number): string {
  const value = text.trim();
  if (!value || ctx.measureText(value).width <= maxWidth) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${value.slice(0, middle)}…`).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}…`;
}

export function mapLayoutDateText(now = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Draws the current map canvas into a restrained PNG page. Returns the geometry actually used. */
export function drawMapLayout(ctx: MapLayoutContext, image: CanvasImageSource, sourceWidth: number, sourceHeight: number,
  options: MapLayoutOptions, now = new Date()): MapLayoutGeometry {
  const preset = mapLayoutPreset(options.preset);
  const geometry = mapLayoutGeometry(options.preset, sourceWidth, sourceHeight);
  const dark = options.theme === "dark";
  const palette = dark
    ? { page: "#111827", map: "#0b1220", text: "#f8fafc", muted: "#94a3b8", border: "#1f2a3d", accent: "#3b82f6" }
    : { page: "#ffffff", map: "#e2e8f0", text: "#0f172a", muted: "#64748b", border: "#e2e8f0", accent: "#2563eb" };
  const titleSize = Math.max(24, Math.round(Math.min(geometry.pageWidth, geometry.pageHeight) * 0.032));
  const subtitleSize = Math.max(14, Math.round(Math.min(geometry.pageWidth, geometry.pageHeight) * 0.014));
  const footerSize = Math.max(12, Math.round(Math.min(geometry.pageWidth, geometry.pageHeight) * 0.012));
  const innerWidth = geometry.pageWidth - geometry.margin * 2;

  ctx.fillStyle = palette.page;
  ctx.fillRect(0, 0, geometry.pageWidth, geometry.pageHeight);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(geometry.margin, geometry.margin, Math.round(innerWidth * 0.055), Math.max(5, Math.round(geometry.pageHeight * 0.005)));

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = palette.text;
  ctx.font = `700 ${titleSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(fittedText(ctx, options.title || "TIPHYS 地图", innerWidth), geometry.margin, geometry.margin + titleSize + 26);
  if (options.subtitle?.trim()) {
    ctx.fillStyle = palette.muted;
    ctx.font = `400 ${subtitleSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(fittedText(ctx, options.subtitle, innerWidth), geometry.margin, geometry.margin + titleSize + subtitleSize + 38);
  }

  ctx.fillStyle = palette.map;
  ctx.fillRect(geometry.mapFrame.x, geometry.mapFrame.y, geometry.mapFrame.width, geometry.mapFrame.height);
  ctx.drawImage(image, geometry.image.x, geometry.image.y, geometry.image.width, geometry.image.height);
  ctx.fillStyle = palette.border;
  ctx.fillRect(geometry.mapFrame.x, geometry.mapFrame.y, geometry.mapFrame.width, 1);
  ctx.fillRect(geometry.mapFrame.x, geometry.mapFrame.y + geometry.mapFrame.height - 1, geometry.mapFrame.width, 1);

  const footerY = geometry.pageHeight - geometry.margin;
  ctx.fillStyle = palette.border;
  ctx.fillRect(geometry.margin, footerY - footerSize - 12, innerWidth, 1);
  ctx.fillStyle = palette.muted;
  ctx.font = `400 ${footerSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText("TIPHYS · 当前地图视图 · PNG 布局（非 PDF）", geometry.margin, footerY);
  ctx.textAlign = "right";
  ctx.fillText(options.includeDate === false ? preset.label : `${preset.label} · ${mapLayoutDateText(now)}`, geometry.pageWidth - geometry.margin, footerY);
  return geometry;
}

export function downloadMapLayoutPng(mapCanvas: HTMLCanvasElement, options: MapLayoutOptions, now = new Date()): string {
  if (typeof document === "undefined") throw new Error("当前环境不支持浏览器下载。");
  const preset = mapLayoutPreset(options.preset);
  const output = document.createElement("canvas");
  output.width = preset.width;
  output.height = preset.height;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("浏览器无法创建布局画布，请更换浏览器后重试。");
  drawMapLayout(ctx, mapCanvas, mapCanvas.width, mapCanvas.height, options, now);
  let dataUrl = "";
  try {
    dataUrl = output.toDataURL("image/png");
  } catch {
    throw new Error("布局 PNG 无法生成：地图画布不可导出，请切换底图或等待地图渲染完成后重试。");
  }
  if (!dataUrl.startsWith("data:image/png")) throw new Error("布局 PNG 为空，请等待地图渲染完成后重试。");
  return downloadDataUrl(dataUrl, mapLayoutFilename(options.preset, now));
}
