# STOCKPILOT: Handoff Tracker

Purpose: anyone (human or agent) can read this file and resume the build without
reading the whole conversation history.

Last updated: 2026-09-21
Current phase: 1 of 10 (Foundation and scaffolding)

---

## Where the project stands right now

The repository is initialized and the scope is locked. No application code has
been written yet. The next real work is installing the Rust toolchain so the
Anchor program can be built, because the on chain policy engine is the highest
risk item in the whole project and it is being built first on purpose.

## Locked decisions (do not relitigate without a reason)

1. Product is STOCKPILOT. The mandate is enforced on chain, not by the model.
2. Prize targets: main track and Pyth. PreStocks is a stretch goal.
3. Tessera, Clawpump and Meteora DBC are excluded. See `docs/SCOPE.md` section 5.
4. PreStocks and Tessera are mutually exclusive. Picking one forfeits the other.
5. Devnet only. No mainnet, no real capital, no token launch.
6. Stack is Next.js 15, Anchor, Pyth Hermes, Anthropic SDK, Drizzle over SQLite.

## Environment findings

| Tool | Status |
| --- | --- |
| Node | v22.18.0, present |
| npm | 11.5.2, present |
| git | 2.50.1, present |
| Solana CLI | 3.1.14, present at `~/.local/share/solana/install/active_release/bin` |
| Anchor CLI | 0.31.0, present at `~/.local/bin/anchor` |
| Rust and cargo | NOT INSTALLED. Blocking for Anchor builds. |
| WSL | Ubuntu 24.04 present but has no toolchain installed |
| pnpm | not installed, use npm |

## Completed

- [x] Repository initialized with ignore rules for node, Next.js and Anchor
- [x] Scope locked and written to `docs/SCOPE.md`
- [x] Line ending normalization configured
- [x] Handoff tracker created
- [x] Test log created

## Next action

Install the Rust toolchain via rustup so that `anchor build` can run. Anchor CLI
0.31.0 is already present but cannot compile anything without cargo.

Decision still open: install Rust natively on Windows, or install the full
toolchain inside the existing WSL Ubuntu 24.04. Native Windows is faster to set
up. WSL is the path Anchor documents and tends to break less on program builds.

## Backlog in priority order

1. Install Rust toolchain and verify `anchor build` succeeds on a stub program
2. Design the mandate and portfolio account layouts
3. Write the Anchor policy program with constraint validation
4. Write program tests proving a violating rebalance is rejected on chain
5. Build the Pyth price service with dual feed spread calculation
6. Build the agent pipeline with schema validated structured output
7. Scaffold the Next.js application shell and wallet connection
8. Build the mandate authoring flow
9. Build the portfolio and agent activity views
10. Build thesis breaker monitoring
11. Write the demo script and record the walkthrough
12. Write the README and submit

## Known risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Anchor builds fail on Windows | High. Blocks the core differentiator. | Fall back to WSL Ubuntu 24.04, which is already installed. |
| Devnet instability or airdrop limits | Medium. Blocks demo. | Cache a funded keypair early. Keep a local validator as fallback. |
| Pyth feed IDs for tokenized stocks differ from docs | Medium. Weakens Pyth bounty. | Verify every feed ID against Hermes before wiring the UI. |
| Agent output fails schema validation | Medium. Breaks the pipeline. | Validate and repair with a retry. Never let raw model output reach the chain. |
| Scope creep into excluded bounties | High. Loses the main track. | `docs/SCOPE.md` section 9 is the reference. Re read before adding features. |

## Commit progress

Target is 30 or more commits by completion.
Current count: 5
