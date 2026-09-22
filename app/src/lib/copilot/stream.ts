import type { CopilotEvent } from "./events";

/**
 * Reads the copilot stream in the browser.
 *
 * `EventSource` would be the obvious tool and cannot be used: it only issues GET
 * requests, and a conversation plus a wallet address does not belong in a URL.
 * So the stream is read from a POST response body instead, which is a few more
 * lines and no library.
 *
 * The buffering matters more than it looks. A chunk boundary falls wherever the
 * network puts it, routinely mid JSON, so anything after the last complete
 * event has to be held back until the rest of it arrives. Parsing eagerly here
 * produces a stream that works perfectly on a fast local connection and drops
 * events over a real one.
 */
export async function readCopilotStream(
  response: Response,
  onEvent: (event: CopilotEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("the response carried no stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. The final fragment is whatever is
      // left over, which is put back for the next chunk to complete.
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;

        try {
          onEvent(JSON.parse(line.slice(6)) as CopilotEvent);
        } catch {
          // A malformed event is dropped rather than ending the stream. The
          // ones after it are still worth showing.
        }
      }
    }
  } finally {
    // Releasing matters on an aborted read. Without it the connection is held
    // open until garbage collection notices, and a person who sends three
    // questions quickly ends up with three live requests.
    reader.releaseLock();
  }
}
