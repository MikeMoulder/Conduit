# STOCKPILOT: Test Log

Every test run against this project is recorded here: what was run, when, the
command used, the result, and the count. Environment verification checks are
recorded too, because on this project a missing toolchain is a real failure
mode and not a footnote.

Format for each entry:

- Run ID, date, phase
- Command
- Result with pass and fail counts
- Notes and any follow up

---

## Run 001

Date: 2026-09-21
Phase: 1, Foundation
Type: Environment verification

| Check | Command | Result |
| --- | --- | --- |
| Node runtime | `node -v` | PASS, v22.18.0 |
| npm | `npm -v` | PASS, 11.5.2 |
| git | `git --version` | PASS, 2.50.1.windows.1 |
| pnpm | `pnpm -v` | FAIL, not installed. Resolved by using npm. |
| Solana CLI | `solana --version` | PASS, 3.1.14 Agave |
| Anchor CLI | `anchor --version` | PASS, 0.31.0 |
| Rust compiler | `rustc --version` | FAIL, not installed |
| Cargo | `cargo --version` | FAIL, not installed |
| WSL distro present | `wsl --list --quiet` | PASS, Ubuntu-24.04 |
| WSL rust toolchain | `wsl -e rustc --version` | FAIL, not installed in WSL |

Totals: 10 checks, 6 passed, 4 failed.

Notes:
- The pnpm failure is not a blocker. npm is used instead.
- The three Rust related failures are a single root cause: no Rust toolchain on
  the machine. This blocks `anchor build` and is the top item in the backlog.
- Anchor CLI being present without cargo means Anchor was installed as a
  prebuilt binary. It will report a usable version but cannot compile a program.

Follow up: install Rust via rustup, then re run this environment check as Run
002 and confirm the four failures clear.

---

## Run 002

Date: 2026-09-21
Phase: 1, Foundation
Type: Frontend scaffold verification

Scaffold created with `create-next-app` producing Next.js 16.3.5, React 19.2.8
and Tailwind v4.

| Check | Command | Result |
| --- | --- | --- |
| Dependency install | `npm install` | PASS, 438 packages, 0 vulnerabilities |
| Bare type check | `npx tsc --noEmit` | FAIL, `Cannot find name 'LayoutProps'` |
| Lint | `npm run lint` | PASS, 0 errors, 0 warnings |
| Production build | `npm run build` | PASS, 4 static routes generated |
| Fixed type check | `npm run typecheck` | PASS, exit code 0 |

Totals: 5 checks, 4 passed, 1 failed.

Notes:
- The bare type check failure was not a defect in our code. In Next.js 16 the
  `LayoutProps` helper is generated, not hand written. It only exists after
  `next dev`, `next build` or `next typegen` has run. A clean checkout will
  therefore always fail a bare `tsc --noEmit`.
- Confirmed against the framework's own documentation shipped in
  `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
  line 337.
- Resolved by defining the `typecheck` script as `next typegen && tsc --noEmit`
  rather than by weakening TypeScript settings or editing generated types.
- A `verify` script now chains typecheck, lint and build into one command so the
  full gate can be run before every commit that touches the frontend.

Follow up: none. The failure is closed.

---

## Run 003

Date: 2026-09-21
Phase: 1, Foundation
Type: Build host survey

SSH key authentication to 173.212.238.167 was authorized by the user and
verified working. The box was then surveyed before installing anything.

| Check | Result |
| --- | --- |
| SSH key authentication | PASS, connected as root@vmi3288470 |
| Operating system | PASS, Ubuntu 24.04.4 LTS, kernel 6.8.0-137, x86_64 |
| Disk capacity | PASS, 65GB free of 145GB |
| Swap configured | PASS, 6GB swapfile present |
| Compiler toolchain present | PASS, gcc 13.3.0, make 4.3, pkg-config 1.8.1 |
| Build headers present | PASS, libssl-dev, libudev-dev, build-essential |
| protobuf-compiler | FAIL, not installed |
| Rust and cargo | FAIL, not installed |
| Solana CLI | FAIL, not installed |
| Anchor CLI | FAIL, not installed |
| Node and npm | FAIL, not installed |
| CPU headroom | FAIL, load average 4.28 on 4 cores, already saturated |
| RAM headroom | FAIL, 1.6GB available of 7.8GB, 1.5GB of swap already in use |
| Host is dedicated to this project | FAIL, host is running production workloads |

Totals: 14 checks, 6 passed, 8 failed.

Critical finding:

The intended build host is a live production server, not a spare machine. It is
currently serving:

- Caddy on ports 80 and 443, public web traffic
- A Docker container named `orion-app`, up 13 days, reported healthy
- `okx-asp.service` and `okx-asp-bot.service`
- Multiple `next-server` processes, the largest node process holding 3.4GB
- PM2 under `pm2-root.service`
- A VS Code remote server session

Uptime is 42 days.

Assessment:

A first Anchor build compiles several hundred Rust crates and is heavy on both
CPU and RAM. This host has no CPU headroom, since a load average of 4.28 on 4
cores means the run queue is already backed up, and it has roughly 1.6GB of RAM
available against a working set that can exceed that.

Running the build here is expected to produce two bad outcomes at once: a very
slow build, and degraded response times for the live services on port 443 while
it runs.

Recommendation: do not build on this host. See `HANDOFF.md` for the alternatives
put to the user.

Follow up: blocked pending a host decision from the user.

---

## Run 004

Date: 2026-09-21
Phase: 1, Foundation
Type: Build toolchain validation on the VPS

Host decision: build on 173.212.238.167 despite it carrying production
workloads. The risk was raised and the user confirmed. Every build is therefore
run under `nice -n 19` and `ionice -c 3`, with cargo capped to a single job via
`~/.cargo/config.toml`.

| Check | Result |
| --- | --- |
| rustup install | PASS, rustc and cargo 1.98.1 |
| protobuf-compiler install | PASS, libprotoc 3.21.12 |
| Cargo parallelism cap applied | PASS, `jobs = 1` written |
| Existing Node detected before installing | PASS, nvm v20.20.2 and v22.23.2 found |
| Login PATH re-survey | PASS, revealed a full pre-existing Solana toolchain |
| Anchor project scaffold | PASS, `anchor init` succeeded |
| Anchor build | PASS, 340 crates, 4m29s, no errors |
| Deployable artifact produced | PASS, `smoketest.so` at 178K |
| IDL generation | PASS, valid JSON with instruction discriminators |
| Solana CLI configuration | PASS, devnet via a dedicated RPC endpoint |
| Wallet keypair present | PASS, funded with 4.96 SOL on devnet |
| Devnet reachability | PASS, cluster version 4.3.0-rc.0 |
| Node available for Anchor tests | PASS, v20.20.2 default, v22.23.2 available |
| Production stability during build | PASS, load 2.33 to 5.51 then settled at 4.38, memory improved from 1.6GB to 2.3GB free |

Totals: 14 checks, 14 passed, 0 failed.

Key findings:

1. The first survey was wrong, and the reason matters. It ran in a
   non-interactive shell whose PATH omits the tooling directories. Solana CLI
   3.1.15, cargo-build-sbf, anchor-cli 0.31.0, avm 1.0.2, the
   `1.89.0-sbpf-solana-v1.52` rustup toolchain and cached platform-tools v1.52
   and v2.3.3 were all already installed. Only the Rust toolchain was genuinely
   missing. Always re-survey through a login shell before concluding a tool is
   absent.

2. Node was deliberately not installed. The host already runs production
   services on nvm v20.20.2 under PM2. Installing another Node could have
   shadowed it and taken those services down.

3. The devnet wallet is already funded with 4.96 SOL. The previously logged risk
   of devnet airdrop rate limits is closed with no mitigation needed.

4. Anchor debug builds cost roughly 1GB of disk per target directory. The VPS
   has 66GB free, so this is comfortable there. It would have been tight on the
   local machine's 21GB.

5. Throttling worked. The production host stayed responsive throughout, and
   available memory was higher after the build than before it.

Follow up: none. Phase 1 is complete and the build path is proven.

---

## Run 005

Status: NOT YET RUN

Planned: first real program test. Once the mandate and portfolio account layouts
exist, assert that a rebalance which breaches the mandate is rejected on chain
with a specific constraint error, and that a compliant one succeeds.

---

## Running totals

| Metric | Value |
| --- | --- |
| Test runs recorded | 4 |
| Individual checks executed | 43 |
| Checks passed | 30 |
| Checks failed | 13 |
| Failures closed | 13 |
| Failures open | 0 |
| Unit tests written | 0 |
| Integration tests written | 0 |
| On chain program tests written | 0 |
