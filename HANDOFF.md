# STOCKPILOT: Handoff Tracker

Purpose: anyone (human or agent) can read this file and resume the build without
reading the whole conversation history.

Last updated: 2026-09-21
Current phase: 1 of 10 (Foundation and scaffolding)
Commits so far: 10 of a 30 plus target

---

## Where the project stands right now

Scope is locked and the frontend base is scaffolded and verified. Next.js 16.3.5
with React 19.2.8 and Tailwind v4 builds clean, lints clean and type checks
clean.

The project is blocked on one thing only: SSH access to the build VPS. Until the
local public key is authorized on that server, no on chain work can start,
because the machine has no Rust toolchain and the VPS is where the toolchain will
live.

Frontend work can continue in the meantime and transfers to the VPS through git,
so nothing done locally is wasted.

## Locked decisions (do not relitigate without a reason)

1. Product is STOCKPILOT. The mandate is enforced on chain, not by the model.
2. Prize targets: main track and Pyth. PreStocks is a stretch goal.
3. Tessera, Clawpump and Meteora DBC are excluded. See `docs/SCOPE.md` section 5.
4. PreStocks and Tessera are mutually exclusive. Picking one forfeits the other.
5. Devnet only. No mainnet, no real capital, no token launch.
6. Stack is Next.js 16, Anchor, Pyth Hermes, Anthropic SDK, Drizzle over SQLite.
7. The whole project moves to the Ubuntu VPS at 173.212.238.167. That becomes the
   single build environment. Decision made 2026-09-21.
8. Type checking runs `next typegen` first. Never weaken tsconfig to work around
   generated route types. See `docs/TESTLOG.md` Run 002.

## Environment findings

Local Windows machine:

| Tool | Status |
| --- | --- |
| Node | v22.18.0, present |
| npm | 11.5.2, present |
| git | 2.50.1, present |
| Solana CLI | 3.1.14, present |
| Anchor CLI | 0.31.0, present but unusable without cargo |
| Rust and cargo | NOT INSTALLED |
| WSL | Ubuntu 24.04 present but empty. Not being used, superseded by decision 7. |
| pnpm | not installed, use npm |
| OpenSSH | 10.0p2, present |

Build VPS at 173.212.238.167:

| Item | Status |
| --- | --- |
| SSH reachability | Reachable, TCP connection succeeds |
| SSH auth | FAILING. Public key not in the server's authorized_keys. |
| Configured user | root |
| Operating system | Unknown, cannot survey until auth works |
| Toolchain | Unknown, cannot survey until auth works |

## Completed

- [x] Repository initialized with ignore rules for node, Next.js and Anchor
- [x] Scope locked and written to `docs/SCOPE.md`
- [x] Line ending normalization configured
- [x] Handoff tracker created
- [x] Test log created
- [x] Next.js 16 application scaffolded with TypeScript, Tailwind v4 and ESLint
- [x] Frontend verified: install, typecheck, lint and production build all pass
- [x] Typecheck corrected for Next.js 16 generated route types
- [x] Research notes organized into `docs/research`

## Next action

Unblock SSH to the VPS. The user runs this in their own terminal:

    ssh-copy-id -i ~/.ssh/id_ed25519.pub root@173.212.238.167

The agent must not attempt password authentication. Once the key is authorized,
proceed immediately to Run 003 in `docs/TESTLOG.md`.

Local public key fingerprint for reference:
`SHA256:H61+IAXW+AmKolBNKWiaJY6ougPa/3d4Soru9RRCf18`

## Backlog in priority order

1. Unblock SSH access to the VPS
2. Survey the VPS and install Rust, Solana CLI, Anchor and Node
3. Move the repository to the VPS and confirm the frontend still verifies there
4. Compile a stub Anchor program to prove the build path
5. Design the mandate and portfolio account layouts
6. Write the Anchor policy program with constraint validation
7. Write program tests proving a violating rebalance is rejected on chain
8. Build the Pyth price service with dual feed spread calculation
9. Build the agent pipeline with schema validated structured output
10. Build the wallet connection and application shell
11. Build the mandate authoring flow
12. Build the portfolio and agent activity views
13. Build thesis breaker monitoring
14. Write the demo script and record the walkthrough
15. Write the README and submit

## Known risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| SSH access stays blocked | High. No on chain work can start. | Key must be added by the user. Fallback is the local WSL Ubuntu 24.04. |
| VPS is underpowered for Rust builds | Medium. Anchor builds are heavy. | Survey CPU and RAM before installing. Add swap if RAM is under 4GB. |
| Devnet instability or airdrop limits | Medium. Blocks demo. | Cache a funded keypair early. Keep a local validator as fallback. |
| Pyth feed IDs for tokenized stocks differ from docs | Medium. Weakens Pyth bounty. | Verify every feed ID against Hermes before wiring the UI. |
| Agent output fails schema validation | Medium. Breaks the pipeline. | Validate and repair with a retry. Never let raw model output reach the chain. |
| Scope creep into excluded bounties | High. Loses the main track. | `docs/SCOPE.md` section 9 is the reference. Re read before adding features. |
| Next.js 16 differs from older conventions | Medium. Wrong patterns waste time. | Read `app/node_modules/next/dist/docs/` before writing Next specific code. |

## Commit log

| # | Message |
| --- | --- |
| 1 | chore: initialize repository with node, next and anchor ignore rules |
| 2 | docs: lock project scope, prize tracks and build order |
| 3 | chore: normalize line endings with gitattributes |
| 4 | docs: add handoff tracker with decisions, backlog and risks |
| 5 | docs: add test log with run 001 environment verification results |
| 6 | feat: scaffold next.js application with typescript, tailwind and eslint |
| 7 | chore: add typecheck and verify scripts for next 16 route type generation |
| 8 | docs: track agent rules and move research notes into docs/research |
| 9 | docs: record run 002 frontend scaffold verification results |
| 10 | docs: update handoff with vps decision and ssh blocker |
