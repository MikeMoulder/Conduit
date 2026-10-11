/**
 * Solana's send errors carry the whole simulation log: forty lines of program
 * ids and compute counts that read as a crash to anyone who is not debugging
 * the program. These turn one into a sentence a person can act on. The raw
 * error still reaches the server log; this is only what a person reads.
 */

/** Where the machine part of a send error starts. */
const RAW_START = /(?:Simulation failed\.|Transaction simulation failed:|\bLogs:\s*\[|Catch the `SendTransactionError`)/;

const LONGEST = 200;

/** The plain reading of a known failure, checked against the raw text in order. */
const KNOWN: [RegExp, string][] = [
  [/exceeded CUs meter|exceeded maximum compute|computational budget exceeded/i, "Solana ran out of compute for the transaction, so nothing moved."],
  [/insufficient (?:funds|lamports)|Attempt to debit an account but found no record of a prior credit/i, "The agent's wallet did not have enough SOL to pay the network fee, so nothing moved."],
  [/Blockhash not found|block height exceeded/i, "The transaction expired before Solana picked it up, so nothing moved. Trying again usually works."],
];

/**
 * One plain sentence for a raw send error, or the text itself when it is
 * already plain. Words a person wrote ahead of the log are kept.
 */
export function plainChainError(raw: unknown): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const start = text.search(RAW_START);
  const known = KNOWN.find(([pattern]) => pattern.test(text));
  if (start === -1) return known ? known[1] : clip(text);

  // A head ending in a colon is the library's own prefix, not a sentence.
  const head = text.slice(0, start).replace(/[(\s]+$/, "");
  const kept = !head || head.endsWith(":") ? "" : /[.!?]$/.test(head) ? head : `${head}.`;
  const instruction = /Error processing Instruction \d+: ([^.]+)\./.exec(text.slice(start));
  const reason = known
    ? known[1]
    : instruction
      ? `Solana refused it: ${instruction[1].trim().toLowerCase()}.`
      : "Solana refused the transaction, so nothing moved.";
  return clip(kept ? `${kept} ${reason}` : reason);
}

/**
 * A stored summary with a raw error inside it, tidied for reading. Summaries
 * written before errors were made plain kept the whole log; this cleans them
 * on the way out, so history reads the same whenever it was written.
 */
export function tidySummary(summary: string): string {
  return RAW_START.test(summary) ? plainChainError(summary) : summary;
}

function clip(text: string): string {
  if (text.length <= LONGEST) return text;
  const cut = text.slice(0, LONGEST);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}...`;
}
