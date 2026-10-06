#!/usr/bin/env bash
# CI heartbeat (scheduled pipelines, needs full history: GIT_DEPTH 0): fail when docs/log.md has
# not been committed to for more than 24 hours.
set -euo pipefail

readonly LOG_FILE="docs/log.md"
readonly MAX_AGE_SECONDS=86400

last_commit="$(git log -1 --format=%ct -- "$LOG_FILE")"
if [ -z "$last_commit" ]; then
  echo "heartbeat: FAILED, $LOG_FILE has no commits." >&2
  exit 1
fi

now="$(date +%s)"
age=$((now - last_commit))
if [ "$age" -gt "$MAX_AGE_SECONDS" ]; then
  echo "heartbeat: FAILED, $LOG_FILE last changed ${age}s ago (limit ${MAX_AGE_SECONDS}s)." >&2
  exit 1
fi
echo "heartbeat: OK, $LOG_FILE last changed ${age}s ago (limit ${MAX_AGE_SECONDS}s)."
