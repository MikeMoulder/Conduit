import { z } from "zod";

import { getAssetBySymbol, listAssets } from "@/lib/assets";
import { draftMandate } from "@/lib/agents/mandate-draft";
import { GeminiError } from "@/lib/gemini";
import { validateConstraints, validateUniverse } from "@/lib/mandate";

/**
 * Drafts mandate limits from a plain English objective.
 *
 * Returns a suggestion, never a decision. The owner sees every number, can
 * change every number, and signs. This route cannot create a mandate and has no
 * key to sign one with.
 *
 * The suggestion is checked here against the same rules the program applies, so
 * an incoherent draft arrives already labelled rather than being discovered at
 * signing time. The violations are returned rather than corrected: silently
 * adjusting a model's numbers would show the owner limits nobody chose.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  objective: z.string().min(10).max(2000),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join(".") || "(root)",
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const result = await draftMandate({
      objective: parsed.data.objective,
      available: listAssets(),
    });

    const suggestion = result.value;

    // The schema constrains the shape of the symbol list, not its contents. A
    // symbol outside the registry has no mint, so it is dropped here and
    // reported rather than carried into a form that cannot be submitted.
    const known = suggestion.symbols.filter((s) => getAssetBySymbol(s));
    const invented = suggestion.symbols.filter((s) => !getAssetBySymbol(s));

    const violations = [
      ...validateConstraints(suggestion),
      ...validateUniverse(known),
    ];

    return Response.json({
      suggestion: { ...suggestion, symbols: known },
      invented,
      violations,
      model: result.model,
      attempts: result.attempts,
      totalTokens: result.totalTokens,
    });
  } catch (error) {
    if (error instanceof GeminiError) {
      return Response.json(
        {
          error: "could not draft a mandate",
          stage: error.stage,
          detail: error.detail ?? error.message,
        },
        { status: 502 },
      );
    }

    return Response.json(
      { error: "could not draft a mandate", detail: String(error) },
      { status: 500 },
    );
  }
}
