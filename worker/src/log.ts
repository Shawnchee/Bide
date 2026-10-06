// Structured JSON-line logger. Never pass secrets in `fields`.
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

// Redact anything that looks like a secret-bearing key name, defensively.
const SECRET_KEY_RE = /(secret|token|key|keypair|password|authorization)/i;

function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 4).join(" | ") };
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitize(x, depth + 1);
    return out;
  }
  return v;
}

function emit(level: Level, mod: string, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, mod, msg, ...(fields ? (sanitize(fields) as object) : {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export function logger(mod: string) {
  return {
    debug: (msg: string, f?: Record<string, unknown>) => emit("debug", mod, msg, f),
    info: (msg: string, f?: Record<string, unknown>) => emit("info", mod, msg, f),
    warn: (msg: string, f?: Record<string, unknown>) => emit("warn", mod, msg, f),
    error: (msg: string, f?: Record<string, unknown>) => emit("error", mod, msg, f),
  };
}
export type Logger = ReturnType<typeof logger>;
