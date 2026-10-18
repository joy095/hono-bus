/** Minimal structured JSON logger. Workers Logs indexes the JSON fields automatically. */
export type Level = "debug" | "info" | "warn" | "error" | "silent";
export type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export const parseLevel = (v: string | undefined): Level =>
  v && v.toLowerCase() in RANK ? (v.toLowerCase() as Level) : "info";

const replacer = (_k: string, v: unknown) =>
  v instanceof Error
    ? { name: v.name, message: v.message, stack: v.stack }
    : typeof v === "bigint"
      ? v.toString()
      : v;

export type Logger = {
  child(bindings: Fields): Logger;
  enabled(level: Level): boolean;
  debug(msg: string, fields?: Fields | Error): void;
  info(msg: string, fields?: Fields | Error): void;
  warn(msg: string, fields?: Fields | Error): void;
  error(msg: string, fields?: Fields | Error): void;
};

export function createLogger(level: Level = "info", bindings: Fields = {}): Logger {
  const enabled = (l: Level) => RANK[l] >= RANK[level];

  const emit = (l: "debug" | "info" | "warn" | "error", msg: string, extra?: Fields | Error) => {
    if (!enabled(l)) return;
    const fields = extra instanceof Error ? { err: extra } : extra;
    let line: string;
    try {
      line = JSON.stringify({ level: l, msg, ...bindings, ...fields }, replacer);
    } catch {
      line = JSON.stringify({ level: l, msg, note: "unserializable fields" });
    }
    (l === "error" ? console.error : l === "warn" ? console.warn : console.log)(line);
  };

  return {
    child: (b) => createLogger(level, { ...bindings, ...b }),
    enabled,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
