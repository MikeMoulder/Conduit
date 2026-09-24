#!/usr/bin/env bash
#
# Keeps the price publisher running on the build host.
#
# Why it needs keeping alive
# --------------------------
# The program refuses any price older than ten minutes. Every equity, pre IPO
# name and crypto asset is priced by this project's publisher, so if the
# publisher stops, every settlement starts failing ten minutes later, whatever
# else is healthy. During judging that is the difference between a demo that
# works and one that does not.
#
# What this is, and is not
# ------------------------
# A plain restart loop in its own process group. It deliberately does not use
# pm2 or systemd: that host runs other production services under both, and this
# project does not reconfigure anything it did not create. It does not survive a
# host reboot; run `start` again after one.
#
# Usage
# -----
#   scripts/publisher.sh start    start the supervisor if it is not running
#   scripts/publisher.sh stop     stop the supervisor and the publisher
#   scripts/publisher.sh status   running or not, and the last round
#   scripts/publisher.sh logs     follow the log
#
# Run on the build host, from the repository root.

set -euo pipefail

PIDFILE=/tmp/conduit-publisher.pid
LOGFILE=/tmp/conduit-publisher.log

NODE_BIN="${HOME}/.nvm/versions/node/v22.23.2/bin"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

supervise() {
  export PATH="${NODE_BIN}:${PATH}"
  export ANCHOR_PROVIDER_URL="${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}"
  export ANCHOR_WALLET="${ANCHOR_WALLET:-/root/.config/solana/id.json}"

  # Build once up front, then run the compiled script directly, so a restart
  # does not recompile TypeScript every time and a compile error is caught
  # before the loop rather than inside it.
  nice -n 19 ionice -c 3 npm run build:ts >> "$LOGFILE" 2>&1

  while true; do
    echo "[supervisor $(date -u +%H:%M:%S)] starting publisher" >> "$LOGFILE"
    nice -n 19 ionice -c 3 node .test-build/scripts/publish-prices.js --watch \
      >> "$LOGFILE" 2>&1 || true
    # Short enough that no price goes stale while it waits, long enough that a
    # publisher failing on start does not spin the CPU.
    echo "[supervisor $(date -u +%H:%M:%S)] publisher exited, restarting in 30s" >> "$LOGFILE"
    sleep 30
  done
}

case "${1:-status}" in
  start)
    if running; then
      echo "already running, pid $(cat "$PIDFILE")"
      exit 0
    fi
    # setsid gives the loop its own session, so closing the SSH connection that
    # started it cannot take it down.
    setsid bash "$0" __supervise < /dev/null >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "started, pid $(cat "$PIDFILE"), log $LOGFILE"
    ;;

  __supervise)
    supervise
    ;;

  stop)
    if running; then
      # The whole process group, so the node child goes with its supervisor.
      kill -- -"$(cat "$PIDFILE")" 2>/dev/null || kill "$(cat "$PIDFILE")"
      rm -f "$PIDFILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;

  status)
    if running; then
      echo "running, pid $(cat "$PIDFILE")"
    else
      echo "NOT RUNNING. Settlements fail ten minutes after the last round."
    fi
    echo "last rounds:"
    grep -E "^\[[0-9:]+\] fetching|of [0-9]+ published|\[supervisor" "$LOGFILE" 2>/dev/null \
      | tail -6 | sed 's/^/  /'
    ;;

  logs)
    tail -f "$LOGFILE"
    ;;

  *)
    echo "usage: $0 start|stop|status|logs"
    exit 1
    ;;
esac
