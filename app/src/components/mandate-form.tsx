"use client";

import { useEffect, useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { listAssets } from "@/lib/assets";
import { CLUSTER } from "@/lib/cluster";
import {
  MAX_ASSETS,
  bpsToPercent,
  explorerUrl,
  extractProgramError,
  mandatePda,
  portfolioPda,
  type ProgramErrorInfo,
} from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import {
  describeFeedBinding,
  toAllowedAssets,
  validateDraft,
  type MandateConstraintsInput,
  type Violation,
} from "@/lib/mandate";
import { useConduitProgram } from "@/hooks/use-conduit-program";

/**
 * Authoring a mandate.
 *
 * The screen is arranged around one distinction, because it is the distinction
 * the whole project rests on. The objective is prose, read by the agent, and
 * never stored on chain. The limits are numbers, stored on chain, and enforced
 * by the program whatever the prose says. Prose persuades. Numbers bind.
 *
 * Both instructions go in one transaction. A mandate without a portfolio is a
 * constitution with nothing to govern, and leaving that gap open between two
 * signatures means a refused second prompt strands the first. One signature,
 * both accounts, or neither.
 */

const EXAMPLE_OBJECTIVE =
  "Long term growth from large cap technology, with a real tolerance for " +
  "drawdown but no single name allowed to dominate. Keep a meaningful cash " +
  "buffer so a dislocation can be bought rather than watched, and do not churn " +
  "the book.";

/** Coherent by construction. Each one satisfies the check the program runs. */
const PRESETS: Record<string, MandateConstraintsInput> = {
  Conservative: {
    maxPositionBps: 2000,
    minCashBps: 2000,
    maxTurnoverBps: 2000,
    maxAssets: 5,
  },
  Balanced: {
    maxPositionBps: 2500,
    minCashBps: 1000,
    maxTurnoverBps: 4000,
    maxAssets: 6,
  },
  Aggressive: {
    maxPositionBps: 4000,
    minCashBps: 500,
    maxTurnoverBps: 7000,
    maxAssets: 8,
  },
};

interface DraftResponse {
  suggestion: MandateConstraintsInput & {
    symbols: string[];
    interpretation: string;
    rationale: { field: string; reason: string }[];
  };
  invented: string[];
  violations: Violation[];
  model: string;
}

type Submission =
  | { state: "idle" }
  | { state: "signing" }
  | { state: "confirming"; signature: string }
  | { state: "done"; signature: string; slot: number }
  | {
      state: "error";
      message: string;
      programError?: ProgramErrorInfo;
      signature?: string;
    };

export function MandateForm() {
  const assets = useMemo(() => listAssets(), []);
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const program = useConduitProgram();

  const [objective, setObjective] = useState("");
  const [mandateId, setMandateId] = useState(0);
  const [agent, setAgent] = useState("");
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [limits, setLimits] = useState<MandateConstraintsInput>(PRESETS.Balanced);
  const [symbols, setSymbols] = useState<string[]>([]);

  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const [submission, setSubmission] = useState<Submission>({ state: "idle" });

  // The agent address is prefilled from the server rather than typed, because
  // the owner has no reason to know it by heart and a mistyped address produces
  // a mandate whose agent can never sign.
  useEffect(() => {
    let current = true;
    fetch("/api/agent/identity")
      .then((r) => r.json())
      .then((data: { configured: boolean; publicKey?: string; reason?: string }) => {
        if (!current) return;
        if (data.configured && data.publicKey) {
          setAgent(data.publicKey);
          setAgentNote("from the server configuration");
        } else {
          setAgentNote(data.reason ?? "no agent configured");
        }
      })
      .catch(() => {
        if (current) setAgentNote("could not reach the server");
      });
    return () => {
      current = false;
    };
  }, []);

  const draftInput = {
    ...limits,
    objective,
    mandateId,
    symbols,
    agent,
  };
  const violations = validateDraft(draftInput);
  const violationsFor = (field: Violation["field"]) =>
    violations.filter((v) => v.field === field);

  const mandate = publicKey ? mandatePda(publicKey, mandateId) : null;
  const portfolio = mandate ? portfolioPda(mandate) : null;

  const deployable = limits.maxAssets * limits.maxPositionBps;

  async function runDraft() {
    setDrafting(true);
    setDraftError(null);
    try {
      const response = await fetch("/api/mandate/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective }),
      });
      const data = await response.json();

      if (!response.ok) {
        setDraftError(data.detail ?? data.error ?? "the draft request failed");
        return;
      }

      const result = data as DraftResponse;
      setDraft(result);
      setLimits({
        maxPositionBps: result.suggestion.maxPositionBps,
        minCashBps: result.suggestion.minCashBps,
        maxTurnoverBps: result.suggestion.maxTurnoverBps,
        maxAssets: result.suggestion.maxAssets,
      });
      setSymbols(result.suggestion.symbols);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : String(error));
    } finally {
      setDrafting(false);
    }
  }

  async function submit() {
    if (!program || !publicKey || !mandate || !portfolio) return;

    setSubmission({ state: "signing" });

    try {
      const allowedAssets = toAllowedAssets(symbols);

      const createMandate = await program.methods
        .initializeMandate(
          new BN(mandateId),
          {
            maxPositionBps: limits.maxPositionBps,
            minCashBps: limits.minCashBps,
            maxTurnoverBps: limits.maxTurnoverBps,
            maxAssets: limits.maxAssets,
          },
          allowedAssets,
          new PublicKey(agent.trim()),
        )
        .accountsStrict({
          mandate,
          owner: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const createPortfolio = await program.methods
        .initializePortfolio()
        .accountsStrict({
          mandate,
          portfolio,
          owner: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const transaction = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(createMandate, createPortfolio);

      const signature = await sendTransaction(transaction, connection);
      setSubmission({ state: "confirming", signature });

      const outcome = await confirmSignature(connection, signature, {
        lastValidBlockHeight,
      });

      if (outcome.status === "confirmed") {
        setSubmission({ state: "done", signature, slot: outcome.slot });
      } else if (outcome.status === "failed") {
        setSubmission({
          state: "error",
          signature,
          message: "The program refused the transaction.",
          programError: extractProgramError(outcome.error) ?? undefined,
        });
      } else if (outcome.status === "expired") {
        setSubmission({
          state: "error",
          signature,
          message:
            "The transaction expired without landing. Nothing was created and it cannot be replayed.",
        });
      } else {
        setSubmission({
          state: "error",
          signature,
          message:
            "No result within the wait. It may still land, so check the explorer before retrying.",
        });
      }
    } catch (error) {
      const programError = extractProgramError(error);
      setSubmission({
        state: "error",
        message:
          programError?.message ??
          (error instanceof Error ? error.message : String(error)),
        programError: programError ?? undefined,
      });
    }
  }

  const busy = submission.state === "signing" || submission.state === "confirming";
  const canSubmit =
    Boolean(program) && violations.length === 0 && !busy && submission.state !== "done";

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start">
      <div className="flex flex-col gap-8">
        <Section
          title="Objective"
          hint="Plain English. The agent reads this. The chain never sees it."
        >
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={4}
            placeholder="What should this portfolio be trying to do, and what would you refuse to accept along the way?"
            className="w-full resize-y rounded-xl border border-line bg-zinc-950 px-3 py-2 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runDraft}
              disabled={drafting || objective.trim().length < 10}
              className="rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {drafting ? "Reading it" : "Suggest limits from this"}
            </button>
            <button
              type="button"
              onClick={() => setObjective(EXAMPLE_OBJECTIVE)}
              className="text-xs text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
            >
              use an example
            </button>
            <span className="text-xs text-zinc-600">
              A suggestion only. You approve every number, and you sign.
            </span>
          </div>

          {draftError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
              {draftError}
            </p>
          ) : null}

          {draft ? (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-zinc-900/40 px-4 py-3">
              <p className="text-sm leading-relaxed text-zinc-300">
                {draft.suggestion.interpretation}
              </p>
              <ul className="flex flex-col gap-1">
                {draft.suggestion.rationale.map((r, i) => (
                  <li key={i} className="text-xs leading-relaxed text-zinc-500">
                    <span className="font-mono text-zinc-400">{r.field}</span>{" "}
                    {r.reason}
                  </li>
                ))}
              </ul>
              {draft.invented.length > 0 ? (
                <p className="text-xs text-amber-400">
                  Dropped {draft.invented.join(", ")}: not in the registry, so
                  there is no mint to permit.
                </p>
              ) : null}
              <p className="text-xs text-zinc-600">drafted by {draft.model}</p>
            </div>
          ) : null}
        </Section>

        <Section
          title="Limits"
          hint="Numbers. The program re-derives every one of these before anything moves."
        >
          <div className="flex flex-wrap gap-2">
            {Object.entries(PRESETS).map(([name, preset]) => (
              <button
                key={name}
                type="button"
                onClick={() => setLimits(preset)}
                className="rounded-full border border-line px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
              >
                {name}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <BpsField
              label="Maximum single position"
              value={limits.maxPositionBps}
              onChange={(v) => setLimits({ ...limits, maxPositionBps: v })}
              violations={violationsFor("maxPositionBps")}
            />
            <BpsField
              label="Minimum cash held"
              value={limits.minCashBps}
              onChange={(v) => setLimits({ ...limits, minCashBps: v })}
              violations={violationsFor("minCashBps")}
            />
            <BpsField
              label="Maximum turnover per rebalance"
              value={limits.maxTurnoverBps}
              onChange={(v) => setLimits({ ...limits, maxTurnoverBps: v })}
              violations={violationsFor("maxTurnoverBps")}
            />
            <NumberField
              label="Maximum simultaneous positions"
              value={limits.maxAssets}
              min={1}
              max={MAX_ASSETS}
              onChange={(v) => setLimits({ ...limits, maxAssets: v })}
              violations={violationsFor("maxAssets")}
              hint={`${limits.maxAssets} position${
                limits.maxAssets === 1 ? "" : "s"
              } at ${bpsToPercent(limits.maxPositionBps)} reaches ${bpsToPercent(
                deployable,
              )}`}
            />
          </div>
        </Section>

        <Section
          title="Permitted assets"
          hint={`Up to ${MAX_ASSETS}. The agent cannot hold anything outside this list, and cannot add to it.`}
        >
          <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-zinc-800 sm:grid-cols-2">
            {assets.map((asset) => {
              const checked = symbols.includes(asset.symbol);
              const full = symbols.length >= MAX_ASSETS && !checked;
              return (
                <label
                  key={asset.symbol}
                  className={`flex cursor-pointer items-start gap-3 bg-zinc-950 px-3 py-2.5 transition-colors ${
                    full ? "cursor-not-allowed opacity-40" : "hover:bg-zinc-900"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={full}
                    onChange={() =>
                      setSymbols(
                        checked
                          ? symbols.filter((s) => s !== asset.symbol)
                          : [...symbols, asset.symbol],
                      )
                    }
                    className="mt-1 accent-emerald-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-zinc-200">
                      {asset.symbol}
                      <span className="ml-2 text-xs text-zinc-500">
                        {asset.name}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-[11px] text-zinc-600">
                      {describeFeedBinding(asset)}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {violationsFor("universe").map((v, i) => (
            <p key={i} className="text-sm text-red-400">
              {v.message}
            </p>
          ))}
        </Section>

        <Section
          title="Delegation"
          hint="The one key allowed to propose a rebalance. It can do nothing else."
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                spellCheck={false}
                placeholder="Agent address"
                className="min-w-0 flex-1 rounded-xl border border-line bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              {publicKey ? (
                <button
                  type="button"
                  onClick={() => {
                    setAgent(publicKey.toBase58());
                    setAgentNote("your own wallet, so owner and agent are one key");
                  }}
                  className="rounded-xl border border-line-strong px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                >
                  use my wallet
                </button>
              ) : null}
            </div>
            {agentNote ? (
              <p className="text-xs text-zinc-600">{agentNote}</p>
            ) : null}
            {agent && publicKey && agent.trim() === publicKey.toBase58() ? (
              <p className="text-xs leading-relaxed text-amber-400">
                Owner and agent are the same key. Workable for testing, but it
                collapses the separation the program exists to enforce: whoever
                proposes can also pause, close and rewrite the mandate.
              </p>
            ) : null}
            {violationsFor("agent").map((v, i) => (
              <p key={i} className="text-sm text-red-400">
                {v.message}
              </p>
            ))}
          </div>
        </Section>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-24">
        <div className="rounded-2xl border border-line">
          <h3 className="px-4 pb-1 pt-3 text-xs uppercase tracking-wide text-zinc-500">
            What the chain will enforce
          </h3>
          <dl className="flex flex-col">
            <Fact label="max_position_bps" value={String(limits.maxPositionBps)} />
            <Fact label="min_cash_bps" value={String(limits.minCashBps)} />
            <Fact label="max_turnover_bps" value={String(limits.maxTurnoverBps)} />
            <Fact label="max_assets" value={String(limits.maxAssets)} />
            <Fact
              label="allowed_assets"
              value={symbols.length > 0 ? symbols.join(" ") : "none selected"}
            />
            <Fact label="mandate_id" value={String(mandateId)} />
            <Fact
              label="status"
              value="Active"
              note="set by the program, not by you"
            />
          </dl>
        </div>

        {mandate && portfolio ? (
          <div className="rounded-2xl border border-line">
            <h3 className="px-4 pb-1 pt-3 text-xs uppercase tracking-wide text-zinc-500">
              Addresses
            </h3>
            <Fact label="mandate" value={short(mandate.toBase58())} />
            <Fact label="portfolio" value={short(portfolio.toBase58())} />
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 text-xs text-zinc-500">
            Mandate number
            <input
              type="number"
              min={0}
              value={mandateId}
              onChange={(e) => setMandateId(Math.max(0, Number(e.target.value) || 0))}
              className="w-20 rounded-xl border border-line bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {!program
              ? "Connect a wallet"
              : submission.state === "signing"
                ? "Waiting for your signature"
                : submission.state === "confirming"
                  ? "Confirming"
                  : submission.state === "done"
                    ? "Created"
                    : "Create mandate"}
          </button>

          {violations.length > 0 && program ? (
            <p className="text-xs leading-relaxed text-zinc-500">
              {violations.length} thing{violations.length === 1 ? "" : "s"} the
              program would refuse. Each one names the error it would return.
            </p>
          ) : null}
        </div>

        <SubmissionReport submission={submission} />
      </aside>
    </div>
  );
}

function SubmissionReport({ submission }: { submission: Submission }) {
  if (submission.state === "idle" || submission.state === "signing") return null;

  if (submission.state === "confirming") {
    return (
      <p className="rounded-xl border border-line px-4 py-3 text-sm text-zinc-400">
        Sent. Waiting for the cluster to confirm it.
      </p>
    );
  }

  if (submission.state === "done") {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <p className="text-sm text-emerald-300">
          Mandate and portfolio created at slot {submission.slot}.
        </p>
        <a
          href={explorerUrl(submission.signature, "tx", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-emerald-400 underline underline-offset-4"
        >
          {short(submission.signature)}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3">
      {submission.programError ? (
        <>
          <p className="font-mono text-sm text-red-300">
            {submission.programError.name}
          </p>
          <p className="text-sm leading-relaxed text-red-200/80">
            {submission.programError.message}
          </p>
          <p className="text-xs text-red-200/50">
            error {submission.programError.code}, returned by the program
          </p>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-red-200/90">
          {submission.message}
        </p>
      )}
      {submission.signature ? (
        <a
          href={explorerUrl(submission.signature, "tx", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-red-300 underline underline-offset-4"
        >
          {short(submission.signature)}
        </a>
      ) : null}
    </div>
  );
}

function short(value: string): string {
  return `${value.slice(0, 8)}..${value.slice(-8)}`;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
        <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="font-mono text-[11px] text-zinc-500">{label}</dt>
      <dd className="text-right">
        <span className="font-mono text-sm text-zinc-200">{value}</span>
        {note ? (
          <span className="block text-[10px] text-zinc-600">{note}</span>
        ) : null}
      </dd>
    </div>
  );
}

function BpsField({
  label,
  value,
  onChange,
  violations,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  violations: Violation[];
}) {
  return (
    <Field label={label} hint={bpsToPercent(value)} violations={violations}>
      <input
        type="number"
        min={0}
        max={10_000}
        step={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl border border-line bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  violations,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  violations: Violation[];
  hint: string;
}) {
  return (
    <Field label={label} hint={hint} violations={violations}>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl border border-line bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
      />
    </Field>
  );
}

function Field({
  label,
  hint,
  violations,
  children,
}: {
  label: string;
  hint: string;
  violations: Violation[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="font-mono text-xs text-zinc-600">{hint}</span>
      </div>
      {children}
      {violations.map((v, i) => (
        <p key={i} className="text-xs leading-relaxed text-red-400">
          {v.message}
          <span className="ml-1 font-mono text-red-400/60">
            {v.onChainError}
          </span>
        </p>
      ))}
    </div>
  );
}
