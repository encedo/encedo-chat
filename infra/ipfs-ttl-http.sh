#!/bin/sh
# ipfs-ttl-http.sh — the expiry job, over the RPC instead of the CLI.
#
# Same logic as ipfs-ttl-gc.sh; the difference is where it runs. Kubo lives in a
# container, so rather than giving a host cron access to the docker socket —
# which is root on the host, a large privilege for a cleanup task — this runs as
# a sidecar on the same docker network and speaks HTTP to the node.
#
# That works because the RPC lockdown lives at HAProxy, not in Kubo: `files/*`
# and `repo/gc` are refused from outside and still reachable from inside the
# network. Worth knowing rather than discovering: the lockdown protects against
# the world, not between containers.
#
#     IPFS_API=http://ipfs1:5001 TTL=300 sh ipfs-ttl-http.sh
#
# Why MFS holds the ledger, and why `repo gc` on a timer is not an expiry, are
# explained in ipfs-ttl-gc.sh — that reasoning is unchanged.

set -eu

API="${IPFS_API:-http://127.0.0.1:5001}"
TTL="${TTL:-300}"
DIR="${DIR:-/ec}"

rpc() { # rpc <endpoint> [query]
  curl -sS -m 30 -X POST "$API/api/v0/$1${2:+?$2}"
}

# `to-files` does not create its parent, and an upload into a missing directory
# succeeds while writing nothing to the ledger — files that then never expire.
rpc files/mkdir "arg=$DIR&parents=true" >/dev/null 2>&1 || true

now=$(date -u +%s)
removed=0

# Entries come back as {"Entries":[{"Name":"…",…}]}, or with Entries null when
# empty. Names are ours and contain no quotes, so this needs no JSON parser —
# and not depending on jq keeps the sidecar a stock alpine plus curl.
names=$(rpc files/ls "arg=$DIR" | grep -o '"Name":"[^"]*"' | cut -d'"' -f4 || true)

for name in $names; do
  [ -n "$name" ] || continue

  ts=${name%%-*}          # <epoch>-<id>  →  <epoch>
  ts=${ts%%.*}            # nginx $msec is "seconds.milliseconds"; keep seconds

  # Anything not named the way we name things is left alone. Deleting entries a
  # cleanup job does not understand is how it becomes an outage.
  case "$ts" in
    ''|*[!0-9]*) echo "skip (unrecognised name): $name"; continue ;;
  esac

  age=$(( now - ts ))
  if [ "$age" -ge "$TTL" ]; then
    if rpc files/rm "arg=$DIR/$name&recursive=true&force=true" >/dev/null 2>&1; then
      echo "expired after ${age}s: $name"
      removed=$(( removed + 1 ))
    else
      echo "could not remove: $name"
    fi
  fi
done

# Only collect when something was actually unpinned. `repo gc` walks the whole
# blockstore and takes the repo lock; doing that every minute on an idle node is
# work for nothing. Unlike the CLI version this counter survives — the loop is
# not in a pipeline here.
if [ "$removed" -gt 0 ]; then
  rpc repo/gc >/dev/null 2>&1 || true
  echo "gc after removing $removed entr$( [ "$removed" = 1 ] && echo y || echo ies )"
fi

exit 0
