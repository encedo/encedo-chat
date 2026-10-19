#!/bin/sh
# onchato-node entry: `relay`, `stun` or `fput`, flags rendered from the environment
# (node.env, read by compose). The relay flags are the ones our nodes run
# (relay/onchato-relay.service); only what differs per node comes from env.
set -eu

case "${1:-relay}" in
relay)
  : "${NODE_HOST:?NODE_HOST is not set (node.env)}"
  MAX_CONNS=${MAX_CONNS:-400}
  MAX_TOPICS=${MAX_TOPICS:-$((MAX_CONNS * 4))}
  set -- node /app/relay/relay.mjs --port 9001 --key-file /data/node.key --host "$NODE_HOST" \
    --local-topics-only --leaf-announce --pick --announce-load \
    --max-connections "$MAX_CONNS" --max-topics "$MAX_TOPICS" --max-topics-per-peer 150 \
    --stats 15 --quiet-msgs --metrics-port 9003
  # More nodes: the mesh over IPv6 9002 (OPERATOR-GUIDE.md, appendix A).
  if [ -n "${V6_HOST:-}" ]; then set -- "$@" --v6-port 9002 --v6-host "$V6_HOST"; fi
  if [ -n "${PEERS:-}" ]; then set -- "$@" --peers $PEERS; fi
  if [ -n "${SIBLINGS:-}" ]; then set -- "$@" --siblings "$SIBLINGS"; fi
  if [ -n "${REDIS_PORT:-}" ]; then
    set -- "$@" --stats-redis "redis://127.0.0.1:$REDIS_PORT" --stats-node "${NODE_HOST%%.*}" --stats-ttl-days 30
  fi
  cd /app/relay
  exec "$@"
  ;;
stun)
  # The block lists are the node's own (geoblock opt-in, abuse list); absent
  # files mean "not filtering", which stun.mjs says once.
  export GEO_LIST="${GEO_LIST:-/data/geoip/blocked-cidrs.txt,/data/geoip/abuse-cidrs.txt}"
  cd /app/infra/stun
  exec node stun.mjs
  ;;
fput)
  # The upload prefixer in front of the local Kubo (STORE=here): eight bytes
  # before every upload, the sweeper's ledger name (infra/fput/README.md).
  export IPFS_RPC="http://127.0.0.1:${KUBO_API_PORT:-5001}" HOST=127.0.0.1 PORT=9202
  cd /app/infra/fput
  exec node fput.mjs
  ;;
*)
  exec "$@"
  ;;
esac
