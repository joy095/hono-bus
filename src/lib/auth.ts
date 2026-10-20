import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer, openAPI } from "better-auth/plugins";
import type { Db } from "../db/client";
import { csv, trustedOrigins, type Env } from "../env";
import * as authSchema from "../db/schema/auth-schema";

/**
 * Roles
 *  - public:  no account needed (read-only API + subscriber WebSocket)
 *  - user:    signed-in; may publish for buses they are assigned to (bus_drivers)
 *  - admin:   manage buses/stops/drivers, publish for any bus
 * The first admin(s) are bootstrapped through ADMIN_EMAILS; after that use the admin plugin
 * (auth.api.setRole / POST /api/auth/admin/set-role) to promote others.
 *
 * Browsers authenticate with the session cookie; native/driver apps can use
 * `Authorization: Bearer <session token>` (bearer plugin; the token is returned in the
 * `set-auth-token` response header of sign-in).
 */
export default function createAuth(env: Env, db: Db) {
  const admins = new Set(csv(env.ADMIN_EMAILS).map((e) => e.toLowerCase()));
  console.log(admin, "admin");
  // const admins = env.ADMIN_EMAILS;

  const secure = env.BETTER_AUTH_URL.startsWith("https://");

  return betterAuth({
    appName: "Bus Tracking",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [...trustedOrigins(env)],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24, // sliding refresh once a day
      // No cookieCache: bans / revoked sessions must take effect immediately.
    },

    // Isolates don't share memory, so limits live in Postgres (rate_limit table).
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/forget-password": { window: 3600, max: 3 },
      },
    },

    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: "lax" },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (u) => ({
            data: {
              ...u,
              role: admins.has(u.email.toLowerCase()) ? "admin" : "user",
            },
          }),
        },
      },
    },

    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      bearer(),
      openAPI(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
