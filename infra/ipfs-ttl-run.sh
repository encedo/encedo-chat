#!/bin/sh
# ipfs-ttl-run.sh — (re)create the ipfs-ttl sidecar.
#
# NOT needed after a reboot. The container carries `--restart unless-stopped`,
# so Docker brings it back on its own, and the sidecar tolerates `ipfs1` not
# being up yet: `files/ls` returns nothing, the sweep removes nothing, and the
# next minute it works. Start order does not matter.
#
# This exists for every other case — a new server, a different TTL, an image
# bump — where the alternative is reproducing a nine-line `docker run` from
# memory. The deployment does not use compose for this: a single sidecar is one
# container, and putting it in the stack's compose file would mean editing a
# file that belongs to another project.
#
#     sh ipfs-ttl-run.sh                 # TTL 300, the live setting
#     TTL=86400 sh ipfs-ttl-run.sh       # a quiet first pass, deletes nothing recent
#
# Idempotent: it removes any existing container first, so running it twice is
# safe and re-running it is how you change a setting.

set -eu

NET="${NET:-www_network}"
SCRIPT="${SCRIPT:-/opt/my_project/docker/ipfs_ttl/ttl.sh}"
TTL="${TTL:-300}"

# Docker SILENTLY creates a directory when a bind-mount source does not exist,
# so a typo here yields a container mounting an empty directory over /opt/ttl.sh
# — and a failure that points nowhere near its cause.
[ -f "$SCRIPT" ] || { echo "no ttl.sh at $SCRIPT" >&2; exit 1; }

docker rm -f ipfs-ttl 2>/dev/null || true

# `sh /opt/ttl.sh`, not `/opt/ttl.sh`: a bind mount carries the host's
# permissions, and a missing execute bit surfaces as "not found", which reads
# like the mount failed rather than like a chmod.
docker run -d --name ipfs-ttl --restart unless-stopped \
  --network "$NET" \
  -v "$SCRIPT:/opt/ttl.sh:ro" \
  -e IPFS_API=http://ipfs1:5001 -e TTL="$TTL" \
  alpine:3 \
  sh -c "apk add --no-cache curl >/dev/null && while :; do sh /opt/ttl.sh; sleep 60; done"

echo "ok — watch it with: docker logs -f ipfs-ttl"
