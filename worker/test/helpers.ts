import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
/** All fixtures were captured 2026-10-05 ~14:52 UTC; "now" for tests = just after capture. */
export const FIXTURE_NOW = 1791211925000;
