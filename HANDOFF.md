# STOCKPILOT: Handoff Tracker

Purpose: anyone (human or agent) can read this file and resume the build without
reading the whole conversation history.

Last updated: 2026-09-21
Current phase: 1 of 10 COMPLETE. Phase 2 (on chain program) is next.
Commits so far: 13 of a 30 plus target

---

## Where the project stands right now

Phase 1 is done. Scope is locked, the frontend base is verified, and the build
toolchain is proven end to end on the build host by compiling and producing a
real deployable Solana program artifact.

There are currently no open blockers and no open test failures.

The next step is moving the repository to the build host, then designing the
mandate and portfolio account layouts.

## Locked decisions (do not relitigate without a reason)

1. Product is STOCKPILOT. The mandate is enforced on chain, not by the model.
2. Prize targets: main track and Pyth. PreStocks is a stretch goal.
3. Tessera, Clawpump and Meteora DBC are excluded. See `docs/SCOPE.md` section 5.
4. PreStocks and Tessera are mutually exclusive. Picking one forfeits the other.
5. Devnet only. No mainnet, no real capital, no token launch.
6. Stack is Next.js 16, Anchor, Pyth Hermes, Anthropic SDK, Drizzle over SQLite.
7. Build host is the Ubuntu VPS at 173.212.238.167. The risk of building on a
   production box was raised and the user confirmed the choice. Mitigation is
   mandatory throttling, see the build rules below.
8. Type checking runs `next typegen` first. Never weaken tsconfig to work around
   generated route types. See `docs/TESTLOG.md` Run 002.
9. Never install Node on the build host. It already runs production services on
   nvm v20.20.2 under PM2. A second Node could shadow it and break them.

## Build host rules (mandatory)

The host at 173.212.238.167 serves live traffic. Every build must be throttled:

    nice -n 19 ionice -c 3 anchor build

Cargo is already capped to a single job in `~/.cargo/config.toml`. Do not raise
it. A single job holds peak memory near 1GB against roughly 2GB available.

Long builds must be launched with `nohup` into a log file and polled, not run in
the foreground of an SSH session.

Never restart, stop or reconfigure these: `caddy`, `docker` and the `orion-app`
container, `okx-asp`, `okx-asp-bot`, `pm2-root`, `merlin`.

## Verified environment

Build host, 173.212.238.167, Ubuntu 24.04.4 LTS, 4 cores, 7.8GB RAM, 66GB free:

| Tool | Version | Note |
| --- | --- | --- |
| rustc and cargo | 1.98.1 | Installed during phase 1 |
| Solana CLI | 3.1.15 | Pre-existing |
| cargo-build-sbf | 3.1.15 | Pre-existing |
| anchor-cli | 0.31.0 | Pre-existing, builds anchor-lang 0.31.2 |
| avm | 1.0.2 | Pre-existing |
| SBPF toolchain | 1.89.0-sbpf-solana-v1.52 | Pre-existing |
| platform-tools | v1.52 and v2.3.3 | Cached |
| protoc | 3.21.12 | Installed during phase 1 |
| Node | v20.20.2 default, v22.23.2 available | Via nvm, do not touch |
| Foundry forge | 1.7.1 | Pre-existing, unrelated to this project |

Solana configuration on the host:

- Cluster: devnet, through a dedicated Helius RPC endpoint.
- The RPC URL contains an API key. Never commit it. Read it from the host's
  `solana config get` or from an environment variable at runtime.
- Wallet: `3CtgQtLeQ3zGWmvkgVDAtGMn97nARXjksatf2u6tyMTP`
- Devnet balance: 4.96 SOL, enough to deploy without any airdrop.

Local Windows machine, used for frontend work:

- Node v22.18.0, npm 11.5.2, git 2.50.1, OpenSSH 10.0p2.
- Only 21.2GB free disk, which is why heavy Rust builds belong on the host.

## Completed

- [x] Repository initialized with ignore rules for node, Next.js and Anchor
- [x] Scope locked and written to `docs/SCOPE.md`
- [x] Line ending normalization configured
- [x] Handoff tracker and test log created
- [x] Next.js 16 application scaffolded with TypeScript, Tailwind v4 and ESLint
- [x] Frontend verified: install, typecheck, lint and production build all pass
- [x] Typecheck corrected for Next.js 16 generated route types
- [x] Research notes organized into `docs/research`
- [x] SSH access to the build host established
- [x] Build host surveyed, production workloads identified and documented
- [x] Rust toolchain installed and throttling configured
- [x] Anchor build path proven end to end, 340 crates, deployable artifact and IDL
- [x] Devnet connectivity and a funded wallet confirmed

## Next action

Move the repository to the build host. The recommended route is a GitHub
repository, because the hackathon submission requires a public link anyway, and
because it gives a clean sync path between the local machine and the host.

Steps:
1. Create the GitHub repository and push the current 13 commits.
2. Clone it onto the build host.
3. Re run the frontend verification on the host to confirm parity.

## Backlog in priority order

1. Move the repository to the build host and confirm frontend parity
2. Design the mandate and portfolio account layouts
3. Write the Anchor policy program with constraint validation
4. Write program tests proving a violating rebalance is rejected on chain
5. Deploy the program to devnet
6. Build the Pyth price service with dual feed spread calculation
7. Build the agent pipeline with schema validated structured output
8. Build the wallet connection and application shell
9. Build the mandate authoring flow
10. Build the portfolio and agent activity views
11. Build thesis breaker monitoring
12. Write the demo script and record the walkthrough
13. Write the README and submit

## Known risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| No Rust toolchain | CLOSED | Installed and verified in Run 004. |
| Anchor build path unproven | CLOSED | Proven in Run 004, artifact and IDL produced. |
| Devnet airdrop rate limits | CLOSED | Wallet already holds 4.96 SOL. |
| Build destabilizes production | OPEN, mitigated | Mandatory throttling. Load stayed stable in Run 004. |
| Pyth feed IDs differ from docs | OPEN | Verify every feed ID against Hermes before wiring the UI. |
| Agent output fails schema validation | OPEN | Validate and repair with a retry. Never let raw model output reach the chain. |
| Scope creep into excluded bounties | OPEN | `docs/SCOPE.md` section 9 is the reference. |
| Next.js 16 differs from older conventions | OPEN | Read `app/node_modules/next/dist/docs/` before writing Next specific code. |
| Anchor CLI 0.31.0 against anchor-lang 0.31.2 | OPEN, low | Minor mismatch, built cleanly. Pin `anchor-lang` explicitly in Cargo.toml. |

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
| 11 | docs: record run 003 build host survey and capacity findings |
| 12 | docs: record run 004 anchor toolchain validation on build host |
| 13 | docs: update handoff with verified build environment and phase 1 completion |
