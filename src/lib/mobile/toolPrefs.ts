/** Recent/favourite GIS tools for the mobile toolbox (local to this device). */
const RECENT_KEY = "tiphys-mobile-recent-tools";
const FAVOURITE_KEY = "tiphys-mobile-favourite-tools";
const RECENT_LIMIT = 8;

function read(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function recentTools() { return read(RECENT_KEY); }

export function rememberTool(name: string) {
  if (!name) return;
  const next = [name, ...read(RECENT_KEY).filter(item => item !== name)].slice(0, RECENT_LIMIT);
  write(RECENT_KEY, next);
}

export function favouriteTools() { return read(FAVOURITE_KEY); }

export function toggleFavourite(name: string): boolean {
  const current = read(FAVOURITE_KEY);
  const exists = current.includes(name);
  write(FAVOURITE_KEY, exists ? current.filter(item => item !== name) : [name, ...current]);
  return !exists;
}
