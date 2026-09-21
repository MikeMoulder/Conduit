import "server-only";

import type { ZodType } from "zod";

import { getEnv } from "./env";

/**
 * Gemini client for the agent pipeline.
 *
 * Server side only. The key never reaches a browser, same rule as the market
 * data providers.
 *
 * Two behaviours here exist because of what the live API actually does rather
 * than what its documentation suggests, established by probing it directly:
 *
 * 1. Model availability is volatile. The entire 2.5 family returns 404 "no
 *    longer available to new users", the pro tier returns 429 on a free key, and
 *    several flash models return 503 "high demand" intermittently. A single
 *    hardcoded model would fail at random, which during a live demo is
 *    indistinguishable from the product being broken.
 *
 * 2. Structured output works, and is the only acceptable way to get an
 *    allocation out of a model. A number that reaches a transaction must have
 *    passed a schema, never been scraped out of prose.
 *
 * So every call walks a ladder of models, remembers which ones are currently
 * failing, and validates whatever comes back before returning it.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Preference order.
 *
 * Stronger models first, with the one verified to work on a free key last so
 * there is always a floor. Entries that 404, 429 or 503 are skipped for a while
 * rather than retried on every call.
 */
const MODEL_LADDER = [
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
] as const;

/**
 * How long a model is considered unavailable after it fails.
 *
 * Long enough to stop hammering a busy model on every stage of a five stage
 * pipeline, short enough that a transient spike does not sideline a good model
 * for the rest of the session.
 */
const COOLDOWN_MS = 60_000;

/** Model name to the time its cooldown expires. */
const unavailableUntil = new Map<string, number>();

/** Gemini's own schema dialect, which is not JSON Schema. */
export type GeminiSchema = {
  type: "OBJECT" | "ARRAY" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN";
  description?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  nullable?: boolean;
};

export interface GenerateRequest<T> {
  /** Short label used in errors and logs, for example "risk" or "bull". */
  stage: string;
  systemInstruction: string;
  prompt: string;
  schema: GeminiSchema;
  /** Parsed and checked before the caller ever sees it. */
  validator: ZodType<T>;
  /** Upper bound on output tokens. Stages that only decide need very few. */
  maxOutputTokens?: number;
  /**
   * Sampling temperature. Defaults to 0 because these stages make financial
   * decisions, where reproducibility is worth more than variety.
   */
  temperature?: number;
}

export interface GenerateResult<T> {
  value: T;
  /** Which model actually answered, for the activity log. */
  model: string;
  /** Tokens billed, when the API reports them. */
  totalTokens: number | null;
  /** How many attempts were needed, including schema repair. */
  attempts: number;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

function availableModels(preferred: string): string[] {
  const now = Date.now();
  const ordered = [preferred, ...MODEL_LADDER.filter((m) => m !== preferred)];
  const usable = ordered.filter((m) => (unavailableUntil.get(m) ?? 0) <= now);

  // If everything is cooling down, try the whole ladder anyway. A stale cooldown
  // is a worse failure than one extra request.
  return usable.length > 0 ? usable : ordered;
}

interface RawResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

async function callModel(
  model: string,
  body: unknown,
): Promise<{ ok: true; data: RawResponse } | { ok: false; status: number; detail: string }> {
  const env = getEnv();

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": env.GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, status: 0, detail: String(error) };
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as RawResponse;
      detail = parsed.error?.message?.slice(0, 200) ?? detail;
    } catch {
      // Keep the raw body; a non JSON error is still worth reporting.
    }
    return { ok: false, status: response.status, detail };
  }

  return { ok: true, data: JSON.parse(text) as RawResponse };
}

function extractText(data: RawResponse): string | null {
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * Runs one stage and returns a value that has passed its schema.
 *
 * Failure handling, in order:
 *   404, 429, 503  the model is put in cooldown and the next one is tried
 *   malformed JSON or schema mismatch  one repair attempt, quoting the problem
 *   nothing left   throws GeminiError
 *
 * The repair attempt matters. Models occasionally emit a number as a string or
 * omit an optional-looking field, and asking once with the specific complaint
 * fixes it far more often than it does not. What is never done is coercing a bad
 * response into a good looking one.
 */
export async function generateStructured<T>(
  request: GenerateRequest<T>,
): Promise<GenerateResult<T>> {
  const env = getEnv();
  const models = availableModels(env.GEMINI_MODEL);

  const buildBody = (prompt: string) => ({
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: request.schema,
      temperature: request.temperature ?? 0,
      maxOutputTokens: request.maxOutputTokens ?? 8192,
    },
  });

  let attempts = 0;
  const failures: string[] = [];

  for (const model of models) {
    for (let repair = 0; repair <= 1; repair += 1) {
      attempts += 1;

      const prompt =
        repair === 0
          ? request.prompt
          : `${request.prompt}\n\nYour previous reply did not satisfy the schema: ${failures[failures.length - 1]}\nReturn only valid JSON matching the schema exactly.`;

      const response = await callModel(model, buildBody(prompt));

      if (!response.ok) {
        // Availability problems are a property of the model, not the prompt, so
        // repairing would be pointless. Move on.
        if ([404, 429, 503, 500, 0].includes(response.status)) {
          unavailableUntil.set(model, Date.now() + COOLDOWN_MS);
          failures.push(`${model}: http ${response.status} ${response.detail}`);
          break;
        }
        failures.push(`${model}: http ${response.status} ${response.detail}`);
        continue;
      }

      const text = extractText(response.data);
      if (!text) {
        const reason = response.data.candidates?.[0]?.finishReason ?? "unknown";
        failures.push(`${model}: empty response, finishReason=${reason}`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        failures.push(`${model}: response was not JSON (${String(error).slice(0, 80)})`);
        continue;
      }

      const checked = request.validator.safeParse(parsed);
      if (!checked.success) {
        failures.push(
          `${model}: ${checked.error.issues
            .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
            .join("; ")
            .slice(0, 200)}`,
        );
        continue;
      }

      return {
        value: checked.data,
        model,
        totalTokens: response.data.usageMetadata?.totalTokenCount ?? null,
        attempts,
      };
    }
  }

  throw new GeminiError(
    `stage "${request.stage}" produced no schema valid response after ${attempts} attempts`,
    request.stage,
    failures.join(" | "),
  );
}

/** Clears cooldown state. Intended for tests. */
export function resetModelAvailability(): void {
  unavailableUntil.clear();
}
