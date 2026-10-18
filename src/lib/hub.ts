import type { Env } from "../env";

/** One global hub. To shard by city/region, derive the name from a query param instead. */
export const hubOf = (env: Pick<Env, "LIVE_HUB">) =>
  env.LIVE_HUB.get(env.LIVE_HUB.idFromName("global"));
