import { z } from "zod";
import { startScheduler } from "@/lib/autopilot/scheduler";

import { runCopilot } from "@/lib/copilot/loop";
import type { CopilotEvent } from "@/lib/copilot/events";

/**
 * The copilot, streamed.
 *
 * Server sent events rather than a single JSON reply, because the interesting
 * part of a question that takes twenty seconds is what is happening during the
 * twenty seconds. A tool starting, a price arriving, a stage finishing: each is
 * worth showing the moment it occurs. A spinner that resolves into a wall of
 * text hides exactly the work this product is trying to prove it did.
 *
 * Plain SSE over a ReadableStream, with no framework. The protocol is four
 * lines of encoder, the events are already typed, and a library would add a
 * dependency to save nothing.
 */

export const dynamic = "force-dynamic";

/**
 * Long enough for several tool calls including a full pipeline run, which is
 * itself five sequential model calls on a rate limited key.
 */
export const maxDuration = 300;

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
  owner: z.string().min(32).max(44).nullable().optional(),
});

export async function POST(request: Request): Promise<Response> {
  // Starts the autopilot timer if this process has not yet. Idempotent.
  startScheduler();
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

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: CopilotEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // The browser went away mid answer. Nothing to recover.
          closed = true;
        }
      };

      try {
        await runCopilot(
          {
            messages: parsed.data.messages,
            owner: parsed.data.owner ?? null,
          },
          send,
          request.signal,
        );
      } catch (error) {
        send({
          type: "error",
          message: "The copilot stopped unexpectedly.",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Stops a reverse proxy buffering the stream into one lump, which would
      // defeat the whole point of streaming it.
      "x-accel-buffering": "no",
    },
  });
}
