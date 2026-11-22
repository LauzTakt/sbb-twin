#!/usr/bin/env bash
# Private twin instances for verification (never 8787/8080). No realtime, no MQTT broker, no secrets.
#   verify/twin.sh start <port> <repo-dir> [extra env...]   e.g. verify/twin.sh start 8805 /workspace/rail-twin
#   verify/twin.sh stop <port>
#   verify/twin.sh wait <port>
set -euo pipefail
cmd=${1:?start|stop|wait}; port=${2:?port}
case "$port" in 8787|8080) echo "refusing shared port $port" >&2; exit 1;; esac
STATE_DIR=${VERIFY_STATE_DIR:-/tmp/claude-1000/-workspace/fd11487b-ad76-4fbd-b488-79355a506188/scratchpad/verify}
mkdir -p "$STATE_DIR"
pids_on_port() {
  for p in /proc/[0-9]*; do
    if { tr "\0" "\n" < "$p/environ"; } 2>/dev/null | grep -qx "PORT=$port"; then
      { tr "\0" "\n" < "$p/environ"; } 2>/dev/null | grep -qx "VERIFY_TWIN=1" && echo "${p#/proc/}"
    fi
  done
}
case "$cmd" in
  start)
    dir=${3:?repo dir}; shift 3
    [ -n "$(pids_on_port)" ] && { echo "port $port already has a verify twin" >&2; exit 1; }
    rm -f "$STATE_DIR/state-$port.json"
    ( cd "$dir" && env VERIFY_TWIN=1 RAIL_ENV_FILE=/nonexistent NODE_ENV=production MQTT_URL= OTD_GTFS_RT_KEY= OTD_GTFS_SA_KEY= \
        ANTHROPIC_API_KEY= RAIL_STATE_FILE="$STATE_DIR/state-$port.json" PORT="$port" "$@" \
        nohup npx tsx src/main.ts > "$STATE_DIR/twin-$port.log" 2>&1 & echo "started twin $port from $dir (log $STATE_DIR/twin-$port.log)" )
    ;;
  wait)
    for i in $(seq 1 240); do
      curl -fsS "http://127.0.0.1:$port/api/status" > /dev/null 2>&1 && { echo "twin $port up after ${i}s"; exit 0; }
      sleep 1
    done
    echo "twin $port not up" >&2; tail -20 "$STATE_DIR/twin-$port.log" >&2; exit 1
    ;;
  stop)
    for pid in $(pids_on_port); do kill "$pid" 2>/dev/null && echo "stopped $pid"; done
    ;;
esac
