/** Lazy heavy decoders: GDAL (gdal3.js, CDN on demand, ~40 MB once, then browser-cached) and 7-Zip (bundled, ~1.8 MB). */
const GDAL_CDN = "https://cdn.jsdelivr.net/npm/gdal3.js@2.8.1/dist/package";
let gdalPromise: Promise<any> | null = null;
export function loadGdal(): Promise<any> {
  return gdalPromise ??= new Promise((resolve, reject) => {
    const ready = () => (window as any).initGdalJs({ path: GDAL_CDN, useWorker: false }).then(resolve, reject);
    if ((window as any).initGdalJs) { ready(); return; }
    const script = document.createElement("script");
    script.src = `${GDAL_CDN}/gdal3.js`; script.async = true; script.crossOrigin = "anonymous";
    script.onload = ready;
    script.onerror = () => { gdalPromise = null; reject(new Error("GDAL 组件下载失败（需要联网，首次约 40 MB）。")); };
    document.head.append(script);
  });
}
export type GdalLayerOut = { name: string; file: File; count: number };
/** Convert every vector layer of a GDAL-readable dataset (zipped .gdb, .dxf, .tab bundle, .sqlite …) to WGS84 GeoJSON. */
export async function gdalToGeojson(file: File, opts: { vsizip?: boolean; maxLayers?: number } = {}): Promise<{ layers: GdalLayerOut[]; driver: string; notes: string[] }> {
  const Gdal = await loadGdal();
  const opened = await Gdal.open(file, [], opts.vsizip ? ["vsizip"] : []);
  const notes: string[] = [];
  if (!opened.datasets?.length) throw new Error(`GDAL 无法打开 ${file.name}：${(opened.errors ?? []).map((e: any) => e?.message ?? e).join("；") || "格式不受支持"}`);
  const out: GdalLayerOut[] = [];
  let driver = "";
  try {
    for (const ds of opened.datasets) {
      const info = await Gdal.getInfo(ds);
      driver = info.driverName ?? driver;
      const layers: { name: string; featureCount: number }[] = info.layers ?? [];
      const max = opts.maxLayers ?? 30;
      for (const layer of layers.slice(0, max)) {
        try {
          const result = await Gdal.ogr2ogr(ds, ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-lco", "RFC7946=YES", "-nln", layer.name, layer.name]);
          const bytes: Uint8Array = await Gdal.getFileBytes(result);
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          const count = parsed.features?.length ?? 0;
          if (!count) { notes.push(`「${layer.name}」为空或是无几何的表，已跳过`); continue; }
          out.push({ name: layer.name, count, file: new File([bytes as BlobPart], `${layer.name}.geojson`, { type: "application/geo+json" }) });
        } catch (err) { notes.push(`「${layer.name}」转换失败：${(err as any)?.message ?? err}`); }
      }
      if (layers.length > max) notes.push(`共 ${layers.length} 个图层，仅导入前 ${max} 个`);
    }
  } finally { for (const ds of opened.datasets) { try { await Gdal.close(ds); } catch { /* ignore */ } } }
  return { layers: out, driver, notes };
}

/** Extract a 7z/zip archive (ArcGIS .mpkx/.ppkx/.lpkx/.mmpk are 7-Zip) into path → bytes. */
export async function extract7z(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const [{ default: SevenZip }, { default: wasmUrl }] = await Promise.all([import("7z-wasm"), import("7z-wasm/7zz.wasm?url")]);
  const sz = await SevenZip({ locateFile: () => wasmUrl, print: () => {}, printErr: () => {} } as any);
  sz.FS.writeFile("/in.7z", bytes); sz.FS.mkdir("/out");
  sz.callMain(["x", "/in.7z", "-o/out", "-y"]);
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of sz.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const path = `${dir}/${name}`;
      if (sz.FS.isDir(sz.FS.stat(path).mode)) walk(path); else files[path.slice(5)] = sz.FS.readFile(path);
    }
  };
  walk("/out");
  if (!Object.keys(files).length) throw new Error("压缩包解开后没有文件（可能已损坏或加密）。");
  return files;
}
