#!/bin/sh
# Kubo for a node's file store (STORE=here), run by the kubo image before the
# daemon starts. A private store, not an IPFS node: the API on loopback only
# (the image's default is 0.0.0.0), no gateway to the world, no swarm - the
# daemon runs --offline. Uploads arrive through the prefixer, downloads through
# nginx's /f/<cid> (node/nginx/onchato-extra-store.conf).
set -e
ipfs config Addresses.API "/ip4/127.0.0.1/tcp/${KUBO_API_PORT:-5001}"
ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/${KUBO_GATEWAY_PORT:-8089}"
ipfs config --json Addresses.Swarm '[]'
ipfs config --json Addresses.Announce '[]'
ipfs config Datastore.StorageMax "${KUBO_STORAGE_MAX:-8GB}"
# The sweeper's ledger (infra/ipfs-ttl.sh) must exist before the first upload:
# an upload into a missing /ec succeeds and writes nothing to the ledger - a file
# that never expires. The sweeper creates it too, but only once Kubo answers,
# which is after the first uploads can arrive.
ipfs files mkdir -p /ec 2>/dev/null || true
