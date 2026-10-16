#!/bin/sh
# live-test.sh - onchato-bot against real daemons over the real relays.
#
#   sh tools/onchato-bot/live-test.sh      (from the repo root; Node 24, python3)
#
# Three temporary profiles: `bot` (daemon + onchato-bot serve), `szef` (daemon,
# the bot's admin by fingerprint), `nowy` (only a link). szef asks `ping`, then
# adds `nowy` from chat with `dodaj <link>` + `tak <code>`; the bot's daemon
# must hold the new contact at once. Leaves nothing running.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI="node $ROOT/impl/cli/onchato.ts"
BOT="python3 -I $ROOT/tools/onchato-bot/onchato-bot.py"
T=$(mktemp -d "${HOME}/ec-logs/bot-live-XXXXXX")
export ONCHATO_PASSWORD='kot pies dom lampa'
PIDS=''
# A background `as ...` is a subshell: its node child must go too.
cleanup() { for p in $PIDS; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
as() { who=$1; shift; ONCHATO_HOME="$T/$who" ONCHATO_SOCKET="$T/$who.sock" $CLI "$@"; }
link() { as "$1" invite | grep -o 'https://[^ ]*'; }
fail() { echo "FAIL - $*"; echo "logs: $T"; exit 1; }
wait_for() { i=0; until grep -q "$2" "$1" 2>/dev/null; do i=$((i+1)); [ $i -lt 120 ] || fail "timed out: $3"; sleep 1; done; }

for p in bot szef nowy; do as $p profile new $p >/dev/null; done
as bot add "$(link szef)" --yes >/dev/null
as szef add "$(link bot)" --yes >/dev/null
SZEF_FP=$(as szef whoami | grep -o '[0-9A-F][0-9A-F]\(:[0-9A-F][0-9A-F]\)\{7\}' | head -1)
echo "  - profiles bot, szef (admin $SZEF_FP), nowy; bot and szef hold each other"

as bot daemon > "$T/bot.log" 2>&1 & PIDS="$PIDS $!"
as szef daemon > "$T/szef.log" 2>&1 & PIDS="$PIDS $!"
wait_for "$T/bot.log" 'gniazdo' 'bot daemon'
wait_for "$T/szef.log" 'gniazdo' 'szef daemon'
cat > "$T/bot.json" <<EOF
{ "socket": "$T/bot.sock", "name": "live", "admins": ["$SZEF_FP"],
  "commands": { "ping": { "run": ["echo", "pong"] } } }
EOF
$BOT --config "$T/bot.json" serve > "$T/serve.log" 2>&1 & PIDS="$PIDS $!"
as szef listen --json > "$T/szef.events" 2>&1 & PIDS="$PIDS $!"
sleep 2
echo "  - two daemons, onchato-bot serve, szef listening"

as szef send bot ping --wait 60 >/dev/null || fail "szef -> bot ping not delivered"
wait_for "$T/szef.events" '\[live\] pong' 'pong'
echo "  - ping -> [live] pong"

NOWY=$(link nowy)
as szef send bot "dodaj $NOWY Nowak" --wait 60 >/dev/null
wait_for "$T/szef.events" 'odpisz: tak' 'the confirmation request'
CODE=$(grep -o 'odpisz: tak [0-9A-F]*' "$T/szef.events" | head -1 | awk '{print $3}')
as bot contacts | grep -q Nowak && fail "added before the confirmation"
as szef send bot "tak $CODE" --wait 60 >/dev/null
wait_for "$T/szef.events" 'dodano Nowak' 'the add result'
as bot contacts | grep -q Nowak || fail "the bot's daemon does not list Nowak"
grep -q 'nowy kontakt: Nowak' "$T/bot.log" || fail "the daemon did not take Nowak live"
echo "  - dodaj <link> Nowak -> code $CODE -> tak $CODE -> the bot's daemon holds Nowak, no restart"
echo "PASS - onchato-bot over real daemons and relays"
