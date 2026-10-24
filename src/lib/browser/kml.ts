import type { FeatureCollection } from "geojson";

export type KmlPlacemark = {
  name?: string;
  properties: Record<string, string>;
  hasGeometry: boolean;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function elementText(block: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, "i").exec(block);
  return match ? decodeXmlText(match[1]) : undefined;
}

function extendedDataProperties(block: string): Record<string, string> {
  const value: Record<string, string> = {};
  for (const data of block.matchAll(/<(?:[\w.-]+:)?Data\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Data>/gi)) {
    const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(data[1])?.[2];
    if (!name) continue;
    const text = elementText(data[2], "value") ?? elementText(data[2], "displayName");
    if (text !== undefined) value[decodeXmlText(name)] = text;
  }
  for (const data of block.matchAll(/<(?:[\w.-]+:)?SimpleData\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?SimpleData>/gi)) {
    const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(data[1])?.[2];
    if (name) value[decodeXmlText(name)] = decodeXmlText(data[2]);
  }
  return value;
}

/**
 * Extract KML Placemark attributes that the upstream vector converter drops.
 * Geometry still comes from the real converter; this only restores documented
 * KML properties (name, description and ExtendedData/SchemaData values).
 */
export function parseKmlPlacemarks(xml: string): KmlPlacemark[] {
  const marks: KmlPlacemark[] = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Placemark\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Placemark>/gi)) {
    const block = match[1];
    const extended = [...block.matchAll(/<(?:[\w.-]+:)?ExtendedData\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ExtendedData>/gi)]
      .map(item => extendedDataProperties(item[1]))
      .reduce<Record<string, string>>((all, item) => Object.assign(all, item), {});
    const withoutExtended = block
      .replace(/<(?:[\w.-]+:)?ExtendedData\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?ExtendedData>/gi, "")
      .replace(/<(?:[\w.-]+:)?SchemaData\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?SchemaData>/gi, "");
    const name = elementText(withoutExtended, "name");
    const description = elementText(withoutExtended, "description");
    const properties: Record<string, string> = { ...extended };
    if (name) properties.name = name;
    if (description) properties.description = description;
    marks.push({
      name,
      properties,
      hasGeometry: /<(?:[\w.-]+:)?(Point|LineString|LinearRing|Polygon|MultiGeometry|Track)\b/i.test(block),
    });
  }
  return marks;
}

/** Merge restored KML properties into the converter's real geometry output. */
export function mergeKmlProperties(collection: FeatureCollection, marks: KmlPlacemark[]): FeatureCollection {
  const geometric = marks.filter(mark => mark.hasGeometry);
  if (!geometric.length) return collection;
  const byName = new Map<string, KmlPlacemark[]>();
  for (const mark of geometric) {
    if (!mark.name) continue;
    const key = mark.name.toLocaleLowerCase();
    const items = byName.get(key) ?? [];
    items.push(mark);
    byName.set(key, items);
  }
  const positional = geometric.length === collection.features.length;
  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const featureName = typeof feature.properties?.name === "string" ? feature.properties.name.toLocaleLowerCase() : "";
      const named = featureName ? byName.get(featureName)?.shift() : undefined;
      const mark = positional ? geometric[index] : named;
      if (!mark) return feature;
      return { ...feature, properties: { ...(feature.properties ?? {}), ...mark.properties } };
    }),
  };
}
