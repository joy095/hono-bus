import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as authSchema from "./schema/auth-schema";
import * as busSchema from "./schema/bus-schema";

/** bigint columns come back as JS numbers (ids stay well below 2^53). */
const types = {
  bigint: {
    to: 20,
    from: [20],
    serialize: (x: unknown) => String(x),
    parse: (x: string) => Number(x),
  },
};

/**
 * Create a connection per request / DO invocation (Workers must not reuse I/O
 * objects across requests). postgres.js connects lazily and Hyperdrive does the pooling.
 */
export function connect(env: { HYPERDRIVE: Hyperdrive }) {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
    types,
  });
  return {
    sql,
    db: drizzle(sql, { schema: { ...authSchema, ...busSchema } }),
    close: () => sql.end({ timeout: 1 }).catch(() => {}),
  };
}

export type Db = ReturnType<typeof connect>["db"];
