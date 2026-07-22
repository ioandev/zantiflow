#!/usr/bin/env bash
# Last 50 zantiflow plugin lines from Zellij's logs.
#
# The plugin logs to stderr with a "[zantiflow]" prefix (debug lines: "[zantiflow] debug:",
# ADR-0049), which Zellij captures into /tmp/zellij-<uid>/zellij-log/ (rotated). This sweeps
# every file there oldest → newest so the output ends on the most recent lines.
#
#   ./logs.sh       last 50 plugin lines across all log files
#   ./logs.sh -f    follow the live log (plugin lines only)
set -euo pipefail

LOG_DIR="/tmp/zellij-$(id -u)/zellij-log"
if [ ! -d "$LOG_DIR" ]; then
    echo "no Zellij log dir at $LOG_DIR (has Zellij run?)" >&2
    exit 1
fi

if [ "${1:-}" = "-f" ]; then
    exec tail -n 0 -F "$LOG_DIR/zellij.log" | grep --line-buffered zantiflow
fi

lines=$(ls -tr "$LOG_DIR" | while read -r f; do cat "$LOG_DIR/$f"; done | grep zantiflow | tail -n 50 || true)
if [ -z "$lines" ]; then
    echo "no zantiflow lines in $LOG_DIR — is the plugin loaded? (debug \"true\" adds detail)" >&2
    exit 1
fi
printf '%s\n' "$lines"
