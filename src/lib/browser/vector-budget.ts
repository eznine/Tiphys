/**
 * Browser WASM vector budget.
 *
 * The WASM overlay tools allocate the whole layer in one instance. A 21,660-
 * polygon / 645k-vertex layer (GeoAgentBench Bangkok) makes clip/intersection
 * trap with `unreachable`, which also poisons the worker. Refuse such layers
 * before the call with a concrete degrade path instead of pretending the
 * operation ran.
 */
export const BROWSER_VECTOR_BUDGET = {
  maxFeatures: 20_000,
  maxVertices: 500_000,
} as const;

function countPositions(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (value.length >= 2 && value.every(item => typeof item === "number")) return 1;
  return value.reduce((sum: number, item) => sum + countPositions(item), 0);
}

export function countVertices(geojson: { features?: Array<{ geometry?: Record<string, any> | null }> } | undefined): number {
  let total = 0;
  for (const feature of geojson?.features ?? []) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type === "GeometryCollection") {
      total += countVertices({ features: (geometry.geometries ?? []).map((item: any) => ({ geometry: item })) });
    } else {
      total += countPositions(geometry.coordinates);
    }
  }
  return total;
}

export function vectorBudgetError(featureCount: number, vertices: number): string | null {
  if (featureCount > BROWSER_VECTOR_BUDGET.maxFeatures) {
    return `图层有 ${featureCount.toLocaleString()} 个要素，超过浏览器矢量上限（${BROWSER_VECTOR_BUDGET.maxFeatures.toLocaleString()} 个要素 / ${BROWSER_VECTOR_BUDGET.maxVertices.toLocaleString()} 个顶点）。为避免 WASM 崩溃，本次未执行。降级：先用属性或空间条件缩小范围，或导出 GeoPackage 改用桌面 Python 引擎；分块处理后再合并。`;
  }
  if (vertices > BROWSER_VECTOR_BUDGET.maxVertices) {
    return `图层约有 ${vertices.toLocaleString()} 个顶点，超过浏览器矢量上限（${BROWSER_VECTOR_BUDGET.maxFeatures.toLocaleString()} 个要素 / ${BROWSER_VECTOR_BUDGET.maxVertices.toLocaleString()} 个顶点）。为避免 WASM 崩溃，本次未执行。降级：先用属性或空间条件缩小范围，或导出 GeoPackage 改用桌面 Python 引擎；分块处理后再合并。`;
  }
  return null;
}

export function assertBrowserVectorBudget(
  record: { info?: { name?: string; feature_count?: number }; geojson?: { features?: Array<{ geometry?: Record<string, any> | null }> } },
  operation: string,
): void {
  const featureCount = Number(record.info?.feature_count ?? record.geojson?.features?.length ?? 0);
  const vertices = countVertices(record.geojson);
  const error = vectorBudgetError(featureCount, vertices);
  if (error) throw new Error(`${operation}：图层「${record.info?.name ?? "未命名"}」${error}`);
}
