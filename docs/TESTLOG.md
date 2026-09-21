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

Status: NOT YET RUN

Planned: re run environment verification after the Rust toolchain is installed,
then compile a stub Anchor program to prove the build path works end to end
before any real program logic is written.

---

## Running totals

| Metric | Value |
| --- | --- |
| Test runs recorded | 1 |
| Individual checks executed | 10 |
| Checks passed | 6 |
| Checks failed | 4 |
| Unit tests written | 0 |
| Integration tests written | 0 |
| On chain program tests written | 0 |
