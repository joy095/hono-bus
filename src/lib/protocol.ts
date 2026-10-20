/** WebSocket close codes (4000-4999 are application-defined) and internal header names. */
export const CLOSE = {
  NORMAL: 1000,
  POLICY: 1008,
  BAD_REQUEST: 4400, // client must not retry unchanged
  UNAUTHORIZED: 4401, // no/expired session -> sign in again, then reconnect
  FORBIDDEN: 4403, // signed in but not allowed (not assigned to this bus, bad origin)
  NOT_FOUND: 4404, // unknown bus
  IDLE: 4408, // released because it was idle -> reconnect only when needed again
  REPLACED: 4409, // another publisher took over this bus
  RATE_LIMITED: 4429,
} as const;

/** Set by the Worker after it authenticated the request; always overwritten/stripped for public sockets. */
export const HUB_HEADERS = {
  role: "x-hub-role",
  bus: "x-hub-bus",
  user: "x-hub-user",
  exp: "x-hub-exp",
} as const;

export type ClientMsg = {
  op?: unknown;
  id?: unknown;
  busIds?: unknown;
  cells?: unknown;
  items?: unknown;
  [k: string]: unknown;
};
