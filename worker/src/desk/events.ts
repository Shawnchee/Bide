import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MacroEvent } from "./types.js";

interface EventsFile {
  checked_at: string;
  _sources: Record<string, string>;
  events: Omit<MacroEvent, "at_unix">[];
}

let cache: { checked_at: string; sources: Record<string, string>; events: MacroEvent[] } | null = null;

/** Static curated calendar (data/events.json). Never model memory (BUILD §5). */
export function loadEventCalendar() {
  if (cache) return cache;
  const path = fileURLToPath(new URL("./data/events.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as EventsFile;
  const events = raw.events
    .map((e) => {
      const ms = Date.parse(e.at_utc);
      if (!Number.isFinite(ms)) throw new Error(`events.json: bad at_utc for ${e.id}`);
      return { ...e, at_unix: Math.floor(ms / 1000) };
    })
    .sort((a, b) => a.at_unix - b.at_unix);
  cache = { checked_at: raw.checked_at, sources: raw._sources, events };
  return cache;
}

export function eventsBetween(fromUnix: number, toUnix: number): MacroEvent[] {
  return loadEventCalendar().events.filter((e) => e.at_unix >= fromUnix && e.at_unix <= toUnix);
}
