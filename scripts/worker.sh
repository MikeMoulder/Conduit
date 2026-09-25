#!/usr/bin/env bash
#
# Keeps Conduit's background worker running on the build host.
#
# Why it needs keeping alive
# --------------------------
# The site runs on Vercel, where nothing runs between requests. This worker
# is everything that happens with nobody on the page: the autopilot's cycles,
# price triggers firing, the market cards' charts, and the Telegram bot. If it
# stops, triggers stop firing and /start stops linking, silently.
#
# What this is, and is not
# ------------------------
# The same plain restart loop as scripts/publisher.sh, in its own process
# group. It deliberately does not use pm2 or systemd: that host runs other
# production services under both, and this project does not reconfigure
# anything it did not create. It does not survive a host reboot; run `start`
# again after one.
#
# It needs app/.env on the host with the same keys as the site on Vercel,
# including the Upstash settings. The jobs are forced on here whatever the
# file says. And it must be the only process running the background jobs:
# Telegram refuses a second listener for one bot.
#
# Usage
# -----
#   scripts/worker.sh start    start the supervisor if it is not running
#   scripts/worker.sh stop     stop the supervisor and the worker
#   scripts/worker.sh status   running or not, and the latest lines
#   scripts/worker.sh logs     follow the log
#
# Run on the build host, from the repository root.

set -euo pipefail

PIDFILE=/tmp/conduit-worker.pid
LOGFILE=/tmp/conduit-worker.log

NODE_BIN="${HOME}/.nvm/versions/node/v22.23.2/bin"

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

supervise() {
  export PATH="${NODE_BIN}:${PATH}"
  # app/.env is shared with local development and Vercel, where the jobs are
  # off. This process is the one place they run, and a value set here wins
  # over the file.
  export CONDUIT_BACKGROUND_JOBS=on
  cd app

  while true; do
    echo "[supervisor $(date -u +%H:%M:%S)] starting worker" >> "$LOGFILE"
    # Lowest priority, like every build on this host: the production services
    # beside it always come first.
    nice -n 19 ionice -c 3 node --env-file=.env --import tsx --conditions=react-server scripts/worker.ts \
      >> "$LOGFILE" 2>&1 || true
    echo "[supervisor $(date -u +%H:%M:%S)] worker exited, restarting in 15s" >> "$LOGFILE"
    sleep 15
  done
}

case "${1:-status}" in
  start)
    if running; then
      echo "already running, pid $(cat "$PIDFILE")"
      exit 0
    fi
    if [ ! -f app/.env ]; then
      echo "app/.env is missing; the worker needs the same keys as the site"
      exit 1
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
      echo "NOT RUNNING. Triggers do not fire and Telegram does not answer until it starts."
    fi
    echo "latest:"
    grep -E "worker started|alive|failed|warning|unhandled|\[supervisor" "$LOGFILE" 2>/dev/null \
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
