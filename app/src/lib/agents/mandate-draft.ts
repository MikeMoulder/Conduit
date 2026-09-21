import { z } from "zod";

import { generateStructured, type GeminiSchema } from "@/lib/gemini";
import { BPS_DENOMINATOR, MAX_ASSETS } from "@/lib/chain";
import type { RegisteredAsset } from "@/lib/assets";

/**
 * Turns a plain English objective into the numbers a mandate is made of.
 *
 * This is a drafting aid and nothing more. The model proposes limits, the owner
 * reads them and can change every one, and the owner signs. Nothing here
 * reaches the chain without a human signature, and the program checks the
 * result again regardless of where the numbers came from.
 *
 * Worth being precise about why that ordering matters. A model writing its own
 * risk limits would be the exact failure this project exists to prevent. The
 * difference is that these limits are written before the agent runs, reviewed by
 * the person whose money it is, and then enforced by code the agent cannot
 * reach. A suggestion the owner approves is not the same thing as an agent
 * setting its own boundaries.
 */

const bps = z.number().int().min(0).max(BPS_DENOMINATOR);

export const mandateDraftSchema = z.object({
  maxPositionBps: bps,
  minCashBps: bps,
  maxTurnoverBps: bps,
  maxAssets: z.number().int().min(1).max(MAX_ASSETS),
  symbols: z.array(z.string().min(1).max(16)).min(1).max(MAX_ASSETS),
  /** How the model read the objective, so the owner can catch a misreading. */
  interpretation: z.string().min(1).max(600),
  /** One line per limit, saying which words in the objective produced it. */
  rationale: z
    .array(
      z.object({
        field: z.enum([
          "maxPositionBps",
          "minCashBps",
          "maxTurnoverBps",
          "maxAssets",
          "symbols",
        ]),
        reason: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(5),
});

export type MandateDraftSuggestion = z.infer<typeof mandateDraftSchema>;

export const mandateDraftGeminiSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    maxPositionBps: {
      type: "INTEGER",
      description:
        "Largest share any one position may occupy, in basis points. 2000 means 20 percent.",
    },
    minCashBps: {
      type: "INTEGER",
      description: "Smallest share that must stay in cash, in basis points.",
    },
    maxTurnoverBps: {
      type: "INTEGER",
      description:
        "Largest share of the portfolio that may change hands in one rebalance, in basis points.",
    },
    maxAssets: {
      type: "INTEGER",
      description: `Largest number of simultaneous positions, 1 to ${MAX_ASSETS}.`,
    },
    symbols: {
      type: "ARRAY",
      description:
        "Symbols the agent may hold, chosen only from the available list. Never invent one.",
      items: { type: "STRING" },
    },
    interpretation: {
      type: "STRING",
      description:
        "Two or three sentences restating the objective as you understood it, so a misreading is visible.",
    },
    rationale: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          field: {
            type: "STRING",
            enum: [
              "maxPositionBps",
              "minCashBps",
              "maxTurnoverBps",
              "maxAssets",
              "symbols",
            ],
          },
          reason: {
            type: "STRING",
            description:
              "Which part of the objective produced this limit. Quote the wording where there is any.",
          },
        },
        required: ["field", "reason"],
      },
    },
  },
  required: [
    "maxPositionBps",
    "minCashBps",
    "maxTurnoverBps",
    "maxAssets",
    "symbols",
    "interpretation",
    "rationale",
  ],
};

const SYSTEM = `You translate an investment objective written in plain English into
numeric risk limits for an on chain mandate.

You are drafting for a human to review and approve. You are not setting your own
limits and you are not the agent that will trade under them. Prefer the reading
that protects the owner when the wording is ambiguous.

Rules that are not yours to bend, because a program enforces them and will
refuse a mandate that breaks one:

- Every basis point value is a whole number from 0 to ${BPS_DENOMINATOR}.
  ${BPS_DENOMINATOR} is 100 percent, 2000 is 20 percent, 500 is 5 percent.
- maxAssets is from 1 to ${MAX_ASSETS}.
- maxPositionBps must be above 0.
- maxAssets multiplied by maxPositionBps, plus minCashBps, must be at least
  ${BPS_DENOMINATOR}. Otherwise part of the portfolio could never be allocated
  or held, and the mandate is impossible to satisfy. Check this arithmetic
  before answering.
- Every symbol must come from the available list exactly as written.

When the objective gives a number, use it. When it does not, infer from the
language: conservative wording means smaller positions, more cash and less
turnover; aggressive wording means the opposite. Say which words you used.`;

export interface DraftInput {
  objective: string;
  available: RegisteredAsset[];
}

export async function draftMandate(input: DraftInput) {
  const catalogue = input.available
    .map(
      (a) =>
        `${a.symbol}: ${a.name}, ${a.assetClass}, priced by ${a.priceSource}`,
    )
    .join("\n");

  const prompt = `Objective, written by the owner:
"""
${input.objective}
"""

Available assets. Choose only from these, using the symbol exactly:
${catalogue}

Produce the limits and the asset universe.`;

  return generateStructured({
    stage: "mandate-draft",
    systemInstruction: SYSTEM,
    prompt,
    schema: mandateDraftGeminiSchema,
    validator: mandateDraftSchema,
    maxOutputTokens: 1200,
  });
}
