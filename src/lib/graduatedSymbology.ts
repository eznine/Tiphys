import { categoryColors, type ClassBreak, type ClassMethod, type VectorRamp } from "./dataLayers";

export type NumericRange = { min: number; max: number };

export const MIN_CLASS_COUNT = 1;
export const MAX_CLASS_COUNT = 8;

export function clampClassCount(value: unknown): number {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) ? Math.max(MIN_CLASS_COUNT, Math.min(MAX_CLASS_COUNT, count)) : 5;
}

function finiteValues(values: number[]): number[] {
  return values.filter(Number.isFinite);
}

/** Equal-width ranges over an explicit extent. */
export function equalIntervalRanges(min: number, max: number, count: number): NumericRange[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const classes = clampClassCount(count);
  const width = (max - min) / classes;
  return Array.from({ length: classes }, (_, index) => ({
    min: index === 0 ? min : min + width * index,
    max: index === classes - 1 ? max : min + width * (index + 1),
  }));
}

function quantile(sorted: number[], fraction: number): number {
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Quantile ranges use linearly interpolated quantiles and collapse duplicate cut points. */
export function quantileRanges(values: number[], count: number, minOverride?: number, maxOverride?: number): NumericRange[] {
  let numbers = finiteValues(values).sort((a, b) => a - b);
  if (!numbers.length && !(Number.isFinite(minOverride) && Number.isFinite(maxOverride))) return [];
  const lower = Number.isFinite(minOverride) ? Number(minOverride) : numbers[0];
  const upper = Number.isFinite(maxOverride) ? Number(maxOverride) : numbers[numbers.length - 1];
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) return [];
  const classes = clampClassCount(count);
  if (classes === 1) return [{ min: lower, max: upper }];
  numbers = numbers.map(value => Math.max(lower, Math.min(upper, value)));
  const epsilon = Math.max(Number.EPSILON, (upper - lower) * 1e-12);
  const cuts = [lower];
  for (let index = 1; index < classes; index++) {
    const cut = quantile(numbers, index / classes);
    if (cut > cuts[cuts.length - 1] + epsilon && cut < upper - epsilon) cuts.push(cut);
  }
  cuts.push(upper);
  return cuts.slice(1).map((max, index) => ({ min: cuts[index], max }));
}

export function buildGraduatedBreaks(
  values: number[],
  method: ClassMethod,
  count: number,
  ramp: VectorRamp = "blue",
  minOverride?: number,
  maxOverride?: number,
): ClassBreak[] {
  const numbers = finiteValues(values);
  const lower = Number.isFinite(minOverride) ? Number(minOverride) : numbers.length ? Math.min(...numbers) : Number.NaN;
  const upper = Number.isFinite(maxOverride) ? Number(maxOverride) : numbers.length ? Math.max(...numbers) : Number.NaN;
  const ranges = method === "quantile"
    ? quantileRanges(numbers, count, lower, upper)
    : equalIntervalRanges(lower, upper, count);
  const colors = categoryColors(ranges.length, ramp);
  return ranges.map((range, index) => ({ ...range, color: colors[index], label: classRangeLabel(range) }));
}

export function classRangeLabel(range: NumericRange): string {
  return `${formatClassNumber(range.min)} – ${formatClassNumber(range.max)}`;
}

export function formatClassNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1_000_000 || absolute < 0.0001)) return value.toExponential(4);
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}
