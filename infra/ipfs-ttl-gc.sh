#!/bin/sh
# ipfs-ttl-gc.sh — give uploads a lifetime on a node that has no concept of one.
#
# IPFS has no TTL. The usual workaround — add unpinned and run `repo gc` on a
# timer — is not one: GC removes everything unpinned whenever it happens, so a
# file uploaded ten seconds before a sweep lives ten seconds. That is a lottery,
# not an expiry.
#
# So the ledger lives in MFS. Every upload lands at
#
#     /ec/<epoch-seconds>-<request-id>
#
# and an MFS entry keeps its blocks alive (the MFS root is pinned), so `repo gc`
# cannot touch a file while it is listed. The directory listing therefore IS the
# upload log — CID and timestamp, with nothing beside it to fall out of sync,
# nothing to back up, and nothing to lose if this script dies mid-run.
#
# Runs LOCALLY on the IPFS host. `files` and `repo/gc` must stay blocked at the
# proxy: nothing outside this machine has any business calling them.
#
#     */1 * * * *  /usr/local/bin/ipfs-ttl-gc.sh >> /var/log/ipfs-ttl-gc.log 2>&1
#
# Actual lifetime is TTL plus up to one sweep — "five minutes, collected within
# a minute of expiring". The UI must not promise more precision than that.

set -eu

TTL="${TTL:-300}"           # seconds a file may live
DIR="${DIR:-/ec}"           # MFS directory holding uploads
IPFS="${IPFS:-ipfs}"
LOCK="${LOCK:-/tmp/ipfs-ttl-gc.lock}"

# One sweep at a time. `repo gc` takes the repo lock, and a second run waiting on
# it would stack up behind a slow one until the machine notices.
if command -v flock >/dev/null 2>&1; then
  [ "${_LOCKED:-}" = "1" ] || exec env _LOCKED=1 flock -n "$LOCK" "$0" "$@" || exit 0
fi

$IPFS files mkdir -p "$DIR" 2>/dev/null || true

now=$(date -u +%s)
removed=0

# `files ls` prints one name per line. Names are ours, so the only parsing risk
# is a stray entry someone created by hand — hence the digit check below rather
# than trusting the format.
$IPFS files ls "$DIR" 2>/dev/null | while IFS= read -r name; do
  [ -n "$name" ] || continue

  ts=${name%%-*}            # <epoch>-<id>  →  <epoch>
  ts=${ts%%.*}              # nginx $msec is "seconds.milliseconds"; keep seconds

  # Anything not named the way we name things is left alone. Deleting entries we
  # do not understand is how a cleanup job becomes an outage.
  case "$ts" in
    ''|*[!0-9]*) echo "skip (unrecognised name): $name"; continue ;;
  esac

  age=$(( now - ts ))
  if [ "$age" -ge "$TTL" ]; then
    if $IPFS files rm "$DIR/$name" 2>/dev/null; then
      echo "expired after ${age}s: $name"
      removed=$(( removed + 1 ))
    fi
  fi
done

# Only collect when something was actually unpinned. `repo gc` walks the whole
# blockstore and takes the repo lock; running it every minute on an idle node is
# work for nothing.
if $IPFS files ls "$DIR" >/dev/null 2>&1; then
  # The loop above runs in a subshell (pipe), so its counter does not survive.
  # Ask the repo instead: if nothing is collectable, gc is a no-op anyway, and
  # this keeps the check honest rather than clever.
  before=$($IPFS repo stat --size-only 2>/dev/null | awk '/RepoSize/ {print $2}')
  $IPFS repo gc >/dev/null 2>&1 || true
  after=$($IPFS repo stat --size-only 2>/dev/null | awk '/RepoSize/ {print $2}')
  [ "${before:-0}" != "${after:-0}" ] && echo "gc: ${before} -> ${after} bytes"
fi

exit 0
