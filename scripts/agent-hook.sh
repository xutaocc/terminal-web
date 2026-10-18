#!/bin/sh
# terminal-web agent hook — reports a Claude Code / Codex turn to terminal-web.
#
# Installed to ~/.terminal-web/agent-hook.sh by scripts/install-agent-hooks.mjs
# and called by the agent's hook config as:  agent-hook.sh <claude|codex> <Event>
# The hook JSON arrives on stdin.
#
# It must never get in the agent's way: it always exits 0 and posts in the
# background with a short timeout. For Claude it prints {} — a no-op answer that
# Claude's permission hooks need (empty output there is not "no opinion"); for
# Codex it prints nothing, which Codex reads as no opinion. Outside tmux it does nothing — terminal-web
# finds the session from $TMUX_PANE.

agent=$(printf "%s" "${1:-}" | tr -cd "a-z")
event="${2:-}"
input=$(cat 2>/dev/null)
[ "$agent" = claude ] && printf '{}\n'

[ -n "${TMUX_PANE:-}" ] || exit 0

conf="$HOME/.terminal-web/agent-hook.env"
# shellcheck disable=SC1090
[ -r "$conf" ] && . "$conf"
url="${TERMINAL_WEB_URL:-http://127.0.0.1:8090}"
token_file="${TERMINAL_WEB_TOKEN_FILE:-$HOME/.config/terminal-web/auth-token}"
[ -r "$token_file" ] || exit 0
token=$(tr -d '\r\n' < "$token_file")

# First "key":"value" in the payload, reduced to a safe word (no jq needed).
pick() {
  printf '%s' "$input" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 |
    sed 's/.*:[[:space:]]*"//; s/"$//' | tr -cd 'A-Za-z0-9_'
}
[ -n "$event" ] || event=$(pick hook_event_name)
event=$(printf '%s' "$event" | tr -cd 'A-Za-z0-9_')
[ -n "$event" ] || exit 0
tool=$(pick tool_name)
kind=$(pick notification_type)
pane=$(printf '%s' "$TMUX_PANE" | tr -cd '%0-9')
# psmux numbers panes per session (each one's first is %1): it names the
# session in $PSMUX_SESSION, and that is what tells two %1s apart.
session=$(printf '%s' "${PSMUX_SESSION:-}" | tr -cd 'A-Za-z0-9_-')

(
  curl -s -m 2 -o /dev/null \
    -H 'Content-Type: application/json' \
    -b "tw_auth=$token" \
    -d "{\"agent\":\"$agent\",\"pane\":\"$pane\",\"session\":\"$session\",\"event\":\"$event\",\"tool\":\"$tool\",\"kind\":\"$kind\"}" \
    "$url/api/agent-hook" </dev/null >/dev/null 2>&1 &
)
exit 0
