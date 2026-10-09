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
 * Long enough to stop hammering a failing model on every stage of a five stage
 * pipeline, short enough that a transient spike does not sideline a good model
 * for the rest of the session.
 *
 * Split by what the failure means. Out of quota (429) or gone (404) will not
 * change within seconds, so those wait a minute. Busy (503), a server error,
 * a dropped connection or a timeout is the provider's load at that moment,
 * and it passes quickly. Benching the fastest model for a full minute after
 * one 503 pushed the next message onto quota limited and overloaded models:
 * a live "explain what a mandate is" asked seven times and took 40 seconds.
 */
const COOLDOWN_MS = 60_000;
const BUSY_COOLDOWN_MS = 15_000;

/** Puts a model aside after a failure, for as long as that kind of failure lasts. */
function benchModel(model: string, status: number): void {
  if (![404, 408, 429, 503, 500, 0].includes(status)) return;
  const wait = status === 429 || status === 404 ? COOLDOWN_MS : BUSY_COOLDOWN_MS;
  unavailableUntil.set(model, Date.now() + wait);
}

/**
 * Waits between passes over the ladder when another pass could succeed.
 *
 * On a free key the whole ladder shares a per minute budget, so a burst can
 * find every model rate limited at once: a card result sent straight after an
 * answer, or the five stages of an analysis fired back to back. Those limits
 * clear in seconds, and waiting briefly turns a failure into a slower answer.
 *
 * A reply in the wrong shape is worth another pass too. The bull and bear
 * stages regularly need a repair on the fastest model, and an autonomous cycle
 * once stopped because a mix of busy models and one malformed reply fell
 * through a rule that only retried when every failure was a busy model.
 *
 * What is not waited on is what another pass cannot fix: a model that does not
 * exist (404), one that hung for the full timeout (408), or a request the
 * provider rejected outright (400, 401, 403).
 */
const RETRY_DELAYS_MS = [0, 3_000, 8_000];

function worthAnotherPass(failures: string[]): boolean {
  return failures.length > 0 && !failures.every((f) => /http (400|401|403|404|408) /.test(f));
}

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

function availableModels(preferred: string, ignoreCooldowns = false): string[] {
  const now = Date.now();
  const ordered = [preferred, ...MODEL_LADDER.filter((m) => m !== preferred)];
  if (ignoreCooldowns) return ordered;
  const usable = ordered.filter((m) => (unavailableUntil.get(m) ?? 0) <= now);

  // If everything is cooling down, try the whole ladder anyway. A stale cooldown
  // is a worse failure than one extra request.
  return usable.length > 0 ? usable : ordered;
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /**
   * Opaque state the newer models attach to a turn, which they expect back
   * with it in the history. Kept as received, never read.
   */
  thoughtSignature?: string;
  /** Set on a part that is the model's thinking rather than its answer. */
  thought?: boolean;
}

export interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

interface RawResponse {
  candidates?: {
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }[];
  usageMetadata?: { totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

/**
 * The longest one model call may take before it is abandoned.
 *
 * A call with no limit is how a turn sat on "Reading the question" for good:
 * the provider accepted the request under load and never answered, and nothing
 * was timing it. Thirty seconds is well past a normal tool turn, which answers
 * in under ten, so a slow answer is left alone and a hung one is not waited on.
 * A timeout counts as unavailable, so the next model on the ladder takes over.
 */
const MODEL_TIMEOUT_MS = 30_000;

async function callModel(
  model: string,
  body: unknown,
): Promise<{ ok: true; data: RawResponse } | { ok: false; status: number; detail: string }> {
  const env = getEnv();

  let response: Response;
  let text: string;
  try {
    // One signal covers the request and reading the body, since either can
    // be where a stalled connection stops.
    const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
    response = await fetch(`${API_ROOT}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": env.GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    // 408 for a timeout, kept apart from 0 for a dropped connection. A model
    // that hung is moved past, not waited on again: retrying it would multiply
    // the wait by the length of the ladder.
    return timedOut
      ? { ok: false, status: 408, detail: `no answer within ${MODEL_TIMEOUT_MS / 1000}s` }
      : { ok: false, status: 0, detail: String(error) };
  }

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

/** A tool the model may call, in Gemini's own declaration dialect. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

export interface ToolTurnRequest {
  systemInstruction: string;
  /** The whole conversation so far, including prior tool results. */
  contents: GeminiContent[];
  tools: ToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Each piece of prose, as the model writes it. */
  onText?: (delta: string) => void;
  /**
   * Prose already passed to onText is withdrawn: the model failed part way
   * and the next one on the ladder starts the turn again.
   */
  onReset?: () => void;
  /** Stops the turn, and the model's stream with it. */
  signal?: AbortSignal;
  /** A model failed and the next one is about to be asked. */
  onRetry?: (attempt: TurnAttempt) => void;
}

/** One model asked during a turn, and how it went. */
export interface TurnAttempt {
  model: string;
  /** "ok", or what went wrong, such as "http 429" or "timeout". */
  outcome: string;
  ms: number;
}

export interface ToolTurnResult {
  /** Everything the model said this turn: prose, tool calls, or both. */
  parts: GeminiPart[];
  model: string;
  totalTokens: number | null;
  finishReason: string | null;
  /** Every model asked, in order, the one that answered last. */
  attempts?: TurnAttempt[];
}

/**
 * One turn of a tool calling conversation.
 *
 * Separate from `generateStructured` because the two want opposite things. That
 * one constrains the model to a single schema and validates the result. This one
 * must leave the reply open, because a useful turn can be prose, a tool call, or
 * several tool calls at once, and which of those it is cannot be known in
 * advance.
 *
 * The model ladder and its cooldowns are shared, so a model that has just failed
 * a pipeline stage is not immediately retried here.
 *
 * Schema safety does not disappear, it moves. Arguments the model supplies for a
 * tool are validated by the tool before anything runs, which is the same rule as
 * before: a number that reaches a transaction has passed a schema.
 */
export async function generateWithTools(
  request: ToolTurnRequest,
): Promise<ToolTurnResult> {
  const env = getEnv();
  const models = availableModels(env.GEMINI_MODEL);
  const failures: string[] = [];
  const attempts: TurnAttempt[] = [];

  const bodyFor = (model: string) => ({
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    contents: request.contents,
    tools: [{ functionDeclarations: request.tools }],
    generationConfig: {
      temperature: request.temperature ?? 0,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      ...(CHAT_THINKING[model] ? { thinkingConfig: CHAT_THINKING[model] } : {}),
    },
  });

  /*
   * Rounds rather than one pass. On a free key the whole ladder shares a per
   * minute budget, so a burst, such as a card result arriving straight after an
   * answer, can find every model rate limited at once. Those limits clear in
   * seconds. Waiting briefly and trying again turns "no model was available"
   * into a slower answer, which is the better failure for someone mid flow.
   */
  for (let round = 0; round < RETRY_DELAYS_MS.length; round += 1) {
    if (RETRY_DELAYS_MS[round] > 0) {
      if (!worthAnotherPass(failures)) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[round]));
    }

    // Later rounds try every model: the cooldowns were set by this same burst.
    const pass = round === 0 ? models : availableModels(env.GEMINI_MODEL, true);

    for (const model of pass) {
      const began = Date.now();
      const response = await streamModel(model, bodyFor(model), request);

      if (!response.ok) {
        // Prose from a model that then failed is not the answer. Whoever is
        // showing it takes it back before the next model starts again.
        if (response.textSent) request.onReset?.();
        benchModel(model, response.status);
        failures.push(`${model}: http ${response.status} ${response.detail}`);
        const attempt = { model, outcome: response.status === 408 ? "timeout" : `http ${response.status}`, ms: Date.now() - began };
        attempts.push(attempt);
        request.onRetry?.(attempt);
        continue;
      }

      // An empty reply is not usable and is not the prompt's fault, so try the
      // next model rather than reporting silence to the caller as an answer.
      if (response.parts.length === 0) {
        failures.push(`${model}: empty reply, finishReason=${response.finishReason ?? "unknown"}`);
        const attempt = { model, outcome: "empty", ms: Date.now() - began };
        attempts.push(attempt);
        request.onRetry?.(attempt);
        continue;
      }

      attempts.push({ model, outcome: "ok", ms: Date.now() - began });
      reportSlowTurn(attempts);
      return {
        parts: response.parts,
        model,
        totalTokens: response.totalTokens,
        finishReason: response.finishReason,
        attempts,
      };
    }
  }

  reportSlowTurn(attempts);
  throw new GeminiError(
    "no model answered the tool turn",
    "copilot",
    failures.join(" | "),
  );
}

/**
 * How much each model thinks before a chat turn.
 *
 * Measured on the copilot's own prompt and tools: gemini-3.5-flash took 3.2
 * to 6.7 s a turn at its default, with up to 566 tokens of thinking, and 2.2
 * to 2.4 s at minimal. A chat turn picks a tool or writes a few sentences,
 * and the analysis that needs real reasoning has its own stages, so the chat
 * asks for the least. A model not listed is left at its default:
 * gemini-flash-latest refuses minimal outright.
 */
const CHAT_THINKING: Record<string, Record<string, unknown>> = {
  "gemini-3.1-flash-lite": { thinkingLevel: "minimal" },
  "gemini-3.5-flash": { thinkingLevel: "minimal" },
};

/**
 * How long a chat turn waits for a model's first words.
 *
 * A healthy model starts within two or three seconds. One that has accepted
 * the request under load and gone quiet used to be waited on for the full
 * thirty seconds before the ladder moved on, which is most of a fifty second
 * reply. Once words are flowing, the overall limit applies as before.
 */
let firstWordsTimeoutMs = 10_000;

/** Shortens the wait for first words so a test need not sit through ten seconds. Intended for tests. */
export function setFirstWordsTimeout(ms: number): void {
  firstWordsTimeoutMs = ms;
}

/** Logs a turn that needed a fallback or was slow, so a slow reply can be explained afterwards. */
function reportSlowTurn(attempts: TurnAttempt[]): void {
  const total = attempts.reduce((sum, a) => sum + a.ms, 0);
  if (attempts.length <= 1 && total < 6_000) return;
  console.warn(
    `[gemini] chat turn took ${total} ms: ${attempts.map((a) => `${a.model} ${a.outcome} ${a.ms}ms`).join(", ")}`,
  );
}

type StreamOutcome =
  | { ok: true; parts: GeminiPart[]; finishReason: string | null; totalTokens: number | null }
  | { ok: false; status: number; detail: string; textSent: boolean };

/**
 * One model's turn, read as it is written.
 *
 * Prose goes to onText piece by piece; tool calls arrive whole. The parts are
 * put back together the way the non streaming reply had them, consecutive
 * prose joined into one part, so the history the next turn sends is the same
 * shape either way, thought signatures included.
 */
async function streamModel(model: string, body: unknown, request: ToolTurnRequest): Promise<StreamOutcome> {
  const env = getEnv();
  const controller = new AbortController();
  const timeout = (ms: number, what: string) =>
    setTimeout(() => controller.abort(new DOMException(what, "TimeoutError")), ms);
  const stopAll = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) stopAll();
  request.signal?.addEventListener("abort", stopAll);
  let firstWords: ReturnType<typeof setTimeout> | undefined = timeout(
    firstWordsTimeoutMs,
    `no answer started within ${firstWordsTimeoutMs / 1000}s`,
  );
  const overall = timeout(MODEL_TIMEOUT_MS, `no answer within ${MODEL_TIMEOUT_MS / 1000}s`);
  const heard = () => {
    if (firstWords) clearTimeout(firstWords);
    firstWords = undefined;
  };

  const parts: GeminiPart[] = [];
  let finishReason: string | null = null;
  let totalTokens: number | null = null;
  let textSent = false;

  try {
    const response = await fetch(`${API_ROOT}/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = text.slice(0, 200);
      try {
        detail = (JSON.parse(text) as RawResponse).error?.message?.slice(0, 200) ?? detail;
      } catch {
        // Keep the raw body; a non JSON error is still worth reporting.
      }
      return { ok: false, status: response.status, detail, textSent };
    }

    const reader = response.body?.getReader();
    if (!reader) return { ok: false, status: 0, detail: "no response body", textSent };
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The provider separates events with CRLF; normalise before splitting.
      buffer += decoder.decode(value, { stream: true }).split("\r\n").join("\n");

      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");

        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (!data) continue;

        const chunk = JSON.parse(data) as RawResponse;
        if (chunk.error) {
          return { ok: false, status: 500, detail: chunk.error.message?.slice(0, 200) ?? "error mid stream", textSent };
        }
        heard();

        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought) continue;
          if (typeof part.text === "string" && part.text.length > 0) {
            request.onText?.(part.text);
            textSent = true;
          }
          mergePart(parts, part);
        }
        finishReason = candidate?.finishReason ?? finishReason;
        totalTokens = chunk.usageMetadata?.totalTokenCount ?? totalTokens;
      }
    }

    return { ok: true, parts, finishReason, totalTokens };
  } catch (error) {
    // Stopped by the person: not a model failure, nothing to try next.
    if (request.signal?.aborted) throw error;
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    // 408 for a timeout, kept apart from 0 for a dropped connection. A model
    // that hung is moved past, not waited on again: retrying it would multiply
    // the wait by the length of the ladder.
    return timedOut
      ? { ok: false, status: 408, detail: error.message, textSent }
      : { ok: false, status: 0, detail: String(error), textSent };
  } finally {
    if (firstWords) clearTimeout(firstWords);
    clearTimeout(overall);
    request.signal?.removeEventListener("abort", stopAll);
  }
}

/** Adds a streamed part, joining consecutive prose into one part. */
function mergePart(parts: GeminiPart[], part: GeminiPart): void {
  const last = parts[parts.length - 1];
  if (typeof part.text === "string" && last && typeof last.text === "string" && !last.functionCall) {
    last.text += part.text;
    if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
    return;
  }
  parts.push({ ...part });
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

  for (let round = 0; round < RETRY_DELAYS_MS.length; round += 1) {
    if (RETRY_DELAYS_MS[round] > 0) {
      if (!worthAnotherPass(failures)) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[round]));
    }
    // Later rounds try every model: the cooldowns were set by this same burst.
    const pass = round === 0 ? models : availableModels(env.GEMINI_MODEL, true);

    for (const model of pass) {
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
          if ([404, 408, 429, 503, 500, 0].includes(response.status)) {
            benchModel(model, response.status);
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
