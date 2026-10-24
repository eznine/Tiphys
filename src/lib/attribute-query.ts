export type DefinitionOperator = "=" | "!=" | "contains" | ">" | "<" | "is null" | "is not null";

export type AttributeDefinitionQuery = {
  field: string;
  op: DefinitionOperator;
  value: string;
};

export const DEFINITION_OPERATORS: { value: DefinitionOperator; label: string; needsValue: boolean }[] = [
  { value: "=", label: "=", needsValue: true },
  { value: "!=", label: "≠", needsValue: true },
  { value: "contains", label: "包含", needsValue: true },
  { value: ">", label: ">", needsValue: true },
  { value: "<", label: "<", needsValue: true },
  { value: "is null", label: "为空", needsValue: false },
  { value: "is not null", label: "非空", needsValue: false },
];

const OPERATOR_ALIASES: Record<string, DefinitionOperator> = {
  "=": "=", "==": "=", eq: "=",
  "!=": "!=", "<>": "!=", ne: "!=",
  contains: "contains",
  ">": ">", gt: ">",
  "<": "<", lt: "<",
  "is null": "is null", isnull: "is null",
  "is not null": "is not null", notnull: "is not null",
};

/** Reserved row-id/geometry columns stay under engine control and are never rename targets. */
export const RESERVED_ATTRIBUTE_FIELDS = new Set(["id", "fid", "objectid", "ogc_fid", "_tiphys_fid", "geometry", "geom"]);

export function normalizeDefinitionOperator(raw: string): DefinitionOperator | null {
  return OPERATOR_ALIASES[raw.trim().toLocaleLowerCase().replace(/\s+/g, " ")] ?? null;
}

export function definitionOperatorNeedsValue(op: DefinitionOperator): boolean {
  return op !== "is null" && op !== "is not null";
}

export function definitionQueryText(query: AttributeDefinitionQuery): string {
  return definitionOperatorNeedsValue(query.op)
    ? `${query.field} ${query.op} ${query.value}`
    : `${query.field} ${query.op}`;
}

export function fieldRenameError(field: string, newField: string, fieldNames: string[], geometryField?: string): string {
  const reserved = RESERVED_ATTRIBUTE_FIELDS.has(field.toLocaleLowerCase()) || field === geometryField;
  if (reserved) return `字段「${field}」是保留的记录 ID / 几何字段，不能重命名。`;
  const name = newField.trim();
  if (!name) return "新字段名不能为空。";
  if (name === field) return "新字段名与当前字段名相同。";
  if (name.length > 64) return "新字段名最长 64 个字符。";
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ \-]*$/u.test(name)) {
    return "新字段名需以文字、数字或下划线开头，仅可包含文字、数字、空格、下划线和短横线。";
  }
  const lower = name.toLocaleLowerCase();
  if (RESERVED_ATTRIBUTE_FIELDS.has(lower) || name === geometryField) return `字段名「${name}」是保留的 ID / 几何字段名。`;
  if (fieldNames.some(existing => existing !== field && existing.toLocaleLowerCase() === lower)) return `字段「${name}」已存在，请换一个名称。`;
  return "";
}

/** Compare one attribute cell for a definition query. Numeric operators require actual numbers. */
export function matchesDefinitionQuery(value: unknown, op: DefinitionOperator, rawValue: string): boolean {
  if (op === "is null") return value == null;
  if (op === "is not null") return value != null;
  if (value == null) return false;
  if (op === "contains") return String(value).toLocaleLowerCase().includes(rawValue.toLocaleLowerCase());
  if (op === ">" || op === "<") {
    if (typeof value !== "number" || !Number.isFinite(value) || rawValue.trim() === "") return false;
    const target = Number(rawValue);
    if (!Number.isFinite(target)) return false;
    return op === ">" ? value > target : value < target;
  }
  let equal: boolean;
  if (typeof value === "number") {
    const target = Number(rawValue);
    equal = rawValue.trim() !== "" && Number.isFinite(target) && value === target;
  } else if (typeof value === "boolean") {
    equal = String(value).toLocaleLowerCase() === rawValue.trim().toLocaleLowerCase();
  } else {
    equal = String(value) === rawValue;
  }
  return op === "=" ? equal : !equal;
}

export function isNumericField(values: unknown[]): boolean {
  const present = values.filter(value => value != null);
  return present.length > 0 && present.every(value => typeof value === "number" && Number.isFinite(value));
}
