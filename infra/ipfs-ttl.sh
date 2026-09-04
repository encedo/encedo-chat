#!/bin/sh
# ipfs-ttl.sh — give uploads a lifetime on a node that has no concept of one.
#
# Speaks the RPC over HTTP and takes its address from IPFS_API, so it does not
# care where it runs — a sidecar on the docker network in this deployment
# (`http://ipfs1:5001`), a host cron if the API is ever reachable from there.
# One script either way; a CLI variant alongside it would only drift.
#
#     IPFS_API=http://ipfs1:5001 TTL=300 sh ipfs-ttl.sh
#
# It must reach the node DIRECTLY, never through rpc.ipfs.encedo.com: `files/*`
# and `repo/gc` are refused at the edge on purpose. That lockdown protects
# against the world, not within the docker network — which is what makes a
# sidecar work, and worth knowing rather than discovering.
#
# IPFS has no TTL, and the usual workaround is not one: adding unpinned and
# running `repo gc` on a timer removes everything unpinned whenever the timer
# fires, so a file uploaded ten seconds before a sweep lives ten seconds. That
# is a lottery.
#
# So the ledger lives in MFS. Every upload lands at /ec/<epoch>-<request-id>,
# and an MFS entry keeps its blocks alive (the MFS root is pinned), so `repo gc`
# cannot take a file while it is listed. The directory listing therefore IS the
# upload log — CID and timestamp together, nothing beside it to fall out of
# sync, nothing to restore if this script dies mid-run.
#
# Actual lifetime is TTL plus up to one sweep — "five minutes, collected within
# a minute of expiring". The UI must not promise more precision than that.

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

# Entries come back as {"Entries":[{"Name":"...",...}]}, or with Entries null when
# empty. Names are ours and contain no quotes, so this needs no JSON parser —
# and not depending on jq keeps the sidecar a stock alpine plus curl.
names=$(rpc files/ls "arg=$DIR" | grep -o '"Name":"[^"]*"' | cut -d'"' -f4 || true)

for name in $names; do
  [ -n "$name" ] || continue

  ts=${name%%-*}          # <epoch>-<id>  ->  <epoch>
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
