import { z } from "zod";

import type { GeminiSchema } from "../gemini";

/**
 * Schemas for every stage of the agent pipeline.
 *
 * Each stage is declared twice on purpose. Gemini's `responseSchema` uses its
 * own dialect, which is not JSON Schema, and it constrains generation. The zod
 * schema then checks what actually arrived. The two are not redundant: the first
 * steers the model, the second refuses to trust it.
 *
 * That distinction is the whole reason this file exists. The output of this
 * pipeline becomes a financial instruction, so nothing leaves a stage without
 * having been parsed and checked. A model that emits a weight as a string, or
 * invents a symbol, is caught here rather than several layers downstream.
 */

const bps = z
  .number()
  .int("basis points must be a whole number")
  .min(0)
  .max(10_000);

const score = z.number().int().min(1).max(10);

/* -------------------------------------------------------------------------- */
/* Stage 1: research                                                          */
/* -------------------------------------------------------------------------- */

export const researchSchema = z.object({
  marketSummary: z.string().min(1).max(1200),
  findings: z
    .array(
      z.object({
        symbol: z.string().min(1).max(16),
        observation: z.string().min(1).max(600),
        /** How strongly the data supports acting on this name at all. */
        signalStrength: score,
      }),
    )
    .min(1)
    .max(24),
});

export type Research = z.infer<typeof researchSchema>;

export const researchGeminiSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    marketSummary: {
      type: "STRING",
      description: "Two or three sentences on the overall picture.",
    },
    findings: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING", description: "Exact symbol from the data." },
          observation: {
            type: "STRING",
            description:
              "What the data actually says about this asset. Cite the numbers given, never invent any.",
          },
          signalStrength: {
            type: "INTEGER",
            description: "1 to 10. How actionable this observation is.",
          },
        },
        required: ["symbol", "observation", "signalStrength"],
      },
    },
  },
  required: ["marketSummary", "findings"],
};

/* -------------------------------------------------------------------------- */
/* Stage 2 and 3: bull and bear                                               */
/* -------------------------------------------------------------------------- */

export const argumentSchema = z.object({
  cases: z
    .array(
      z.object({
        symbol: z.string().min(1).max(16),
        argument: z.string().min(1).max(700),
        /** Bull: conviction. Bear: severity. Same range either way. */
        weight: score,
      }),
    )
    .min(1)
    .max(24),
});

export type Argument = z.infer<typeof argumentSchema>;

export const argumentGeminiSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    cases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING" },
          argument: { type: "STRING", description: "One tight paragraph." },
          weight: { type: "INTEGER", description: "1 to 10." },
        },
        required: ["symbol", "argument", "weight"],
      },
    },
  },
  required: ["cases"],
};

/* -------------------------------------------------------------------------- */
/* Stage 4: risk                                                              */
/* -------------------------------------------------------------------------- */

export const riskSchema = z.object({
  portfolioConcerns: z.array(z.string().min(1).max(400)).max(8),
  assessments: z
    .array(
      z.object({
        symbol: z.string().min(1).max(16),
        /**
         * The largest weight risk is willing to see in this name.
         *
         * Advisory only. The mandate is the binding limit and the chain enforces
         * it. This exists so the manager stage has a considered view to work
         * against, not so it can raise a cap.
         */
        maxRecommendedBps: bps,
        concern: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(24),
});

export type RiskAssessment = z.infer<typeof riskSchema>;

export const riskGeminiSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    portfolioConcerns: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Risks that apply to the portfolio as a whole.",
    },
    assessments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING" },
          maxRecommendedBps: {
            type: "INTEGER",
            description:
              "Largest acceptable weight in basis points, 0 to 10000. Never above the mandate cap.",
          },
          concern: { type: "STRING" },
        },
        required: ["symbol", "maxRecommendedBps", "concern"],
      },
    },
  },
  required: ["portfolioConcerns", "assessments"],
};

/* -------------------------------------------------------------------------- */
/* Stage 5: portfolio manager                                                 */
/* -------------------------------------------------------------------------- */

export const proposalSchema = z.object({
  positions: z
    .array(
      z.object({
        symbol: z.string().min(1).max(16),
        targetBps: bps,
        thesis: z.string().min(1).max(700),
        /**
         * Conditions that would invalidate the thesis.
         *
         * Required, not optional. A position whose holder cannot say what would
         * change their mind is a position held on faith, and this is the field
         * that later drives automatic review when a condition trips.
         */
        thesisBreakers: z.array(z.string().min(1).max(300)).min(1).max(5),
      }),
    )
    .min(1)
    .max(8),
  reasoning: z.string().min(1).max(1500),
  /** The manager's own confidence in the whole allocation, 1 to 100. */
  confidence: z.number().int().min(1).max(100),
});

export type Proposal = z.infer<typeof proposalSchema>;

export const proposalGeminiSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    positions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          symbol: { type: "STRING", description: "Must be a permitted symbol." },
          targetBps: {
            type: "INTEGER",
            description:
              "Weight in basis points. 2500 means 25 percent. Must not exceed the mandate cap.",
          },
          thesis: { type: "STRING", description: "Why this weight, in one paragraph." },
          thesisBreakers: {
            type: "ARRAY",
            items: { type: "STRING" },
            description:
              "One to five specific, observable conditions that would invalidate this thesis.",
          },
        },
        required: ["symbol", "targetBps", "thesis", "thesisBreakers"],
      },
    },
    reasoning: {
      type: "STRING",
      description:
        "How the bull case, bear case and risk view were weighed against each other.",
    },
    confidence: { type: "INTEGER", description: "1 to 100." },
  },
  required: ["positions", "reasoning", "confidence"],
};
