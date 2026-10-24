export const SHAPEFILE_EXTENSIONS = ["shp", "shx", "dbf", "prj", "cpg", "sbn", "sbx"] as const;
const REQUIRED_SHAPEFILE_PARTS = ["shp", "shx", "dbf"] as const;
const SHAPEFILE_EXTENSION_SET = new Set<string>(SHAPEFILE_EXTENSIONS);

export type ShapefilePart<T> = { name: string; data: T };
export type ShapefileGroup<T> = { stem: string; parts: Map<string, T> };

export function shapefileExtension(name: string): string | undefined {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const extension = base.slice(dot + 1).toLowerCase();
  return SHAPEFILE_EXTENSION_SET.has(extension) ? extension : undefined;
}

export function isShapefilePart(name: string): boolean {
  return shapefileExtension(name) !== undefined;
}

function basenameStem(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function assertShapefileParts(parts: ReadonlyMap<string, unknown>, stem: string): void {
  const label = stem || "未命名";
  if (!parts.has("shp")) {
    throw new Error(`Shapefile「${label}」缺少 .shp 主文件。请选择同名的 .shp、.shx 和 .dbf（可选 .prj/.cpg）。`);
  }
  const missing = REQUIRED_SHAPEFILE_PARTS.filter(extension => !parts.has(extension));
  if (missing.length) {
    throw new Error(`Shapefile「${label}」缺少 ${missing.map(extension => `.${extension}`).join("、")}。请同时选择同名的 .shp、.shx 和 .dbf（可选 .prj/.cpg）。`);
  }
}

export function groupShapefileParts<T>(files: readonly ShapefilePart<T>[]): ShapefileGroup<T>[] {
  const groups = new Map<string, ShapefileGroup<T>>();
  for (const file of files) {
    const extension = shapefileExtension(file.name);
    if (!extension) continue;
    const stem = basenameStem(file.name);
    const key = stem.toLocaleLowerCase();
    const group = groups.get(key) ?? { stem, parts: new Map<string, T>() };
    if (group.parts.has(extension)) throw new Error(`Shapefile「${stem}」包含重复的 .${extension} 文件，请只保留一个。`);
    group.parts.set(extension, file.data);
    groups.set(key, group);
  }
  for (const group of groups.values()) assertShapefileParts(group.parts, group.stem);
  return [...groups.values()];
}
