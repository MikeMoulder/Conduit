/**
 * Runs once when the server starts.
 *
 * Starts the autopilot timer. Node only: the autopilot signs transactions and
 * writes a file, neither of which the edge runtime can do, so it is imported
 * conditionally rather than at the top of this file.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/autopilot/scheduler");
    startScheduler();
  }
}
