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

Status: NOT YET RUN

Blocked on: SSH access to the build VPS at 173.212.238.167. The local public key
is not present in the server's authorized_keys, so key authentication is
rejected. Password authentication was deliberately not attempted.

Planned once unblocked:
1. Verify SSH connectivity and record the VPS operating system and resources.
2. Install the Rust toolchain, Solana CLI, Anchor and Node on the VPS.
3. Re run the environment verification from Run 001 on the VPS and confirm the
   four Rust related failures clear.
4. Compile a stub Anchor program to prove the build path works end to end before
   any real program logic is written.

---

## Running totals

| Metric | Value |
| --- | --- |
| Test runs recorded | 2 |
| Individual checks executed | 15 |
| Checks passed | 10 |
| Checks failed | 5 |
| Failures still open | 4 (all Rust toolchain, see Run 001) |
| Failures closed | 1 (Next.js typegen, see Run 002) |
| Unit tests written | 0 |
| Integration tests written | 0 |
| On chain program tests written | 0 |
