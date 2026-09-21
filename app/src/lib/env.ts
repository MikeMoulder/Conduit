import "server-only";

import { z } from "zod";

/**
 * Server side environment access.
 *
 * Importing this module from a client component is a build error, enforced by
 * the `server-only` package. That guard is deliberate: `PYTH_API_KEY` must never
 * reach the browser bundle. Pyth's documentation is explicit that frontends must
 * not embed the key and that requests should be proxied through a backend, which
 * is why every Pyth call in this project goes through a route handler.
 */
const schema = z.object({
  PYTH_API_KEY: z
    .string()
    .min(1, "PYTH_API_KEY is required. Get a free key at https://pythdata.app"),
  PYTH_HERMES_URL: z.url().default("https://hermes.pyth.network"),
  SOLANA_RPC_URL: z.url(),
  SOLANA_CLUSTER: z.enum(["devnet", "mainnet-beta", "localnet"]).default("devnet"),
  GEMINI_API_KEY: z
    .string()
    .min(1, "GEMINI_API_KEY is required. Create one at https://aistudio.google.com/apikey"),
  GEMINI_MODEL: z.string().default("gemini-2.5-pro"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Validates and returns the environment.
 *
 * Validation is lazy rather than performed at module load so that a missing
 * variable fails at the point of use with a clear message, instead of breaking
 * an unrelated build step. The result is cached because validation is pure.
 *
 * @throws if any required variable is missing or malformed. The message names
 * every offending variable at once so a misconfigured environment is fixed in a
 * single pass rather than one error at a time.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        `Copy app/.env.example to app/.env.local and fill in the missing values.`,
    );
  }

  cached = parsed.data;
  return cached;
}
