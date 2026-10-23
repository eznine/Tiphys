/** Browser-side map export helpers kept separate from MapLibre for testability. */

export type PngCanvas = Pick<HTMLCanvasElement, "toDataURL">;

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

export function downloadMapPng(canvas: PngCanvas, filename = mapExportFilename()): string {
  if (typeof document === "undefined") throw new Error("当前环境不支持浏览器下载。");
  const dataUrl = mapPngDataUrl(canvas);
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return filename;
}
