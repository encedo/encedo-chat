#!/usr/bin/env bash
# onchato-setup.sh - your own onchato network on this server, in a few minutes.
#
#   sudo bash onchato-setup.sh            set up (asks a few questions; re-run to change answers)
#   sudo bash onchato-setup.sh --check    every test the setup did, again
#   sudo bash onchato-setup.sh --update   the latest release, rebuilt and checked
#   sudo bash onchato-setup.sh --renew    sign the network profile again (before it expires)
#        bash onchato-setup.sh --local-test   on a developer machine: no root, no DNS, no
#                                             firewall, a self-signed certificate
#
# What it installs, and why: OPERATOR-GUIDE.md and OPERATOR-NODE-PLAN.md in the
# repository. Answers are kept in /etc/onchato/setup.env; data in /var/lib/onchato;
# code in /opt/onchato. Code is ASCII (repo rule).
set -euo pipefail

MODE=install
LOCAL_TEST=0
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;; --update) MODE=update ;; --renew) MODE=renew ;;
    --local-test) LOCAL_TEST=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $a (--help)"; exit 2 ;;
  esac
done

REPO_URL=${ONCHATO_REPO_URL:-https://github.com/encedo/encedo-chat.git}
# A release puts its own tag here, so the script, the image and the apps stay
# one release apart at most (SECURITY.md, Versions). Unreplaced: the newest tag.
REF=${ONCHATO_REF:-__RELEASE_TAG__}
DIR=${ONCHATO_DIR:-/opt/onchato}
DATA=${ONCHATO_DATA:-/var/lib/onchato}
ETC=${ONCHATO_ETC:-/etc/onchato}
APP_ORIGIN=${ONCHATO_APP:-https://app.onchato.com}

say()  { printf '%s\n' "$*"; }
ok()   { printf '[ok] %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*"; }
die()  { printf '[fail] %s\n' "$*" >&2; exit 1; }
bad=0
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else printf '[fail] %s\n' "$1"; bad=1; fi; }

# ---- 1. the machine ------------------------------------------------------------
preflight() {
  if [ "$LOCAL_TEST" = 1 ]; then
    command -v docker >/dev/null || die "docker is not installed"
    docker compose version >/dev/null 2>&1 || die "docker compose is not available"
    return
  fi
  [ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0"
  . /etc/os-release 2>/dev/null || die "cannot tell which system this is (/etc/os-release)"
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "$(uname -m) is not supported (x86_64 or arm64)";; esac
  local mem; mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  [ "$mem" -ge 900 ] || warn "only ${mem} MB of RAM; 1 GB is the tested minimum"
  for p in 80 443; do
    if ss -ltn "sport = :$p" | grep -q LISTEN && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^onchato-nginx'; then
      die "port $p is already in use by something else (ss -ltnp 'sport = :$p')"
    fi
  done
  if ss -lun "sport = :3478" | grep -q 3478 && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^onchato-stun'; then
    die "port 3478/udp is already in use (STUN needs it)"
  fi
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    case "$ID" in
      ubuntu)
        say "Installing Docker from Ubuntu's own packages..."
        apt-get update -qq && apt-get install -y -qq docker.io docker-compose-v2 git curl >/dev/null
        systemctl enable --now docker >/dev/null ;;
      *)
        die "Docker with the compose plugin is needed and this script installs it only on Ubuntu.
       Install it on $PRETTY_NAME (https://docs.docker.com/engine/install/), then run this again." ;;
    esac
  fi
  command -v git >/dev/null || { [ "$ID" = ubuntu ] || [ "$ID" = debian ] && apt-get install -y -qq git >/dev/null; } || die "git is needed"
  ok "the machine: $PRETTY_NAME, $(uname -m), ${mem} MB, Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
}

# ---- 2. answers ----------------------------------------------------------------
load_answers() { [ -f "$ETC/setup.env" ] && . "$ETC/setup.env" || true; }
ask() { # ask VAR "question" default
  local var=$1 q=$2 def=$3 cur
  cur=${!var:-$def}
  if [ -t 0 ]; then read -r -p "$q [${cur}]: " ans || true; printf -v "$var" '%s' "${ans:-$cur}"
  else printf -v "$var" '%s' "$cur"; fi
}
questions() {
  say ""
  say "A few questions (Enter keeps the value in brackets)."
  ask NODE_HOST    "The server's name (a DNS record pointing at this machine)" "${NODE_HOST:-}"
  [ -n "$NODE_HOST" ] || die "the server's name is needed"
  ask OPERATOR     "Your organisation's name, as people will see it" "${OPERATOR:-}"
  [ -n "$OPERATOR" ] || die "the organisation's name is needed"
  if [ "$LOCAL_TEST" = 1 ]; then ACME_EMAIL=${ACME_EMAIL:-test@localhost}
  else ask ACME_EMAIL "An e-mail for the certificate (Let's Encrypt)" "${ACME_EMAIL:-}"; fi
  if [ -z "${KEY_MODE:-}" ]; then
    say ""
    say "Where is the network's signing key kept? This cannot be changed later without a new network."
    say "  1) on this server, derived from a passphrase you choose (simplest)"
    say "  2) on your own computer or a YubiKey (you sign there and copy the file back)"
    ask KEY_CHOICE "1 or 2" "1"
    case "$KEY_CHOICE" in 2) KEY_MODE=local ;; *) KEY_MODE=server ;; esac
  fi
  local d=${NODE_HOST#*.}; case "$d" in *.*) ;; *) d=$NODE_HOST ;; esac
  DOMAIN=${DOMAIN:-$d}
  NETWORK_ID=${NETWORK_ID:-$DOMAIN}
  HOME_URL=${HOME_URL:-https://$DOMAIN/}
  mkdir -p "$ETC"
  cat > "$ETC/setup.env" <<ENV
# onchato-setup.sh answers - re-run the script to change them.
NODE_HOST='$NODE_HOST'
OPERATOR='${OPERATOR//\'/}'
ACME_EMAIL='$ACME_EMAIL'
KEY_MODE='$KEY_MODE'
DOMAIN='$DOMAIN'
NETWORK_ID='$NETWORK_ID'
HOME_URL='$HOME_URL'
ENV
  chmod 600 "$ETC/setup.env"
}

dns_check() {
  [ "$LOCAL_TEST" = 1 ] && return
  local want mine
  want=$(getent ahostsv4 "$NODE_HOST" | awk '{print $1; exit}')
  mine=$(hostname -I 2>/dev/null || true)
  [ -n "$want" ] || die "$NODE_HOST does not resolve yet - create its A record first, then run this again"
  case " $mine " in *" $want "*) ok "$NODE_HOST points at this machine ($want)" ;;
    *) warn "$NODE_HOST resolves to $want, which is not an address of this machine ($mine). Behind a cloud NAT that can be fine; the certificate step will tell." ;;
  esac
}

firewall() {
  [ "$LOCAL_TEST" = 1 ] && return
  if command -v ufw >/dev/null; then
    # An active firewall is the operator's: SSH stays as they set it (it may be
    # open to two addresses only). A fresh one gets SSH from anywhere, or the
    # enable below would lock the operator out.
    if ufw status | grep -q 'Status: active'; then
      ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 3478/udp comment 'onchato STUN' >/dev/null
      ok "firewall: 80, 443, 3478/udp opened; SSH left as it was"
    else
      ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
      ufw allow 3478/udp comment 'onchato STUN' >/dev/null
      ufw --force enable >/dev/null
      ok "firewall: SSH, 80, 443, 3478/udp open, everything else closed"
    fi
  else
    warn "no ufw here: open 80/tcp, 443/tcp and 3478/udp in your provider's firewall, nothing else"
  fi
}

# ---- 3. the code and the node --------------------------------------------------
fetch_code() {
  if [ -n "${ONCHATO_SRC:-}" ]; then DIR=$ONCHATO_SRC; ok "code: the checkout in $DIR (as it is)"; return; fi
  if [ "$REF" = __RELEASE_TAG__ ]; then
    REF=$(git ls-remote --tags --refs "$REPO_URL" 'v*' | awk -F/ '{print $3}' | sort -V | tail -1)
    [ -n "$REF" ] || die "cannot read the release tags from $REPO_URL"
  fi
  if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q --tags origin && git -C "$DIR" checkout -q "$REF"
  else git clone -q --branch "$REF" --depth 1 "$REPO_URL" "$DIR"; fi
  ok "code: $REF ($(git -C "$DIR" rev-parse --short HEAD)) in $DIR"
}

compose() { ONCHATO_PROFILE_DIR="$DATA/profile" GIT_COMMIT="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)" docker compose -f "$DIR/node/compose.yaml" --env-file "$DIR/node/node.env" "$@"; }
ops() { # ops <docker run options...> -- <onchato-ops args...>
  local opts=() tls=()
  while [ "$1" != -- ]; do opts+=("$1"); shift; done; shift
  [ "$LOCAL_TEST" = 1 ] && tls=(-e NODE_TLS_REJECT_UNAUTHORIZED=0)
  if [ -n "${ONCHATO_PASSPHRASE_FILE:-}" ]; then
    docker run --rm -i "${opts[@]/-it/-i}" "${tls[@]}" --user "$(id -u):$(id -g)" -v "$DATA:/data" -w /data/profile onchato-ops "$@" < "$ONCHATO_PASSPHRASE_FILE"
  else
    docker run --rm "${opts[@]}" "${tls[@]}" --user "$(id -u):$(id -g)" -v "$DATA:/data" -w /data/profile onchato-ops "$@"
  fi
}

start_node() {
  mkdir -p "$DATA/profile"
  cat > "$DIR/node/node.env" <<ENV
# Written by onchato-setup.sh from $ETC/setup.env - re-run the script rather than editing.
NODE_HOST=$NODE_HOST
ACME_EMAIL=$ACME_EMAIL
HOME_URL=$HOME_URL
MAX_CONNS=${MAX_CONNS:-400}
REDIS_PORT=${REDIS_PORT:-6379}
$( [ "$LOCAL_TEST" = 1 ] && echo CERT_MODE=self )
ENV
  say "Building and starting the node (the first time takes a few minutes)..."
  compose up -d --build --quiet-pull >/dev/null 2>&1 || { compose up -d --build; die "the node did not start"; }
  docker build -q -f "$DIR/node/ops/Dockerfile" -t onchato-ops "$DIR" >/dev/null || die "the ops image did not build"
  local i
  for i in $(seq 1 60); do PEER_ID=$(compose logs relay 2>/dev/null | grep -o 'PeerId: 12D3[A-Za-z0-9]*' | tail -1 | cut -d' ' -f2 || true); [ -n "$PEER_ID" ] && break; sleep 2; done
  [ -n "${PEER_ID:-}" ] || die "the relay did not start: docker compose -f $DIR/node/compose.yaml logs relay"
  ok "the relay runs, PeerId $PEER_ID"
  say "Waiting for the certificate..."
  for i in $(seq 1 90); do compose logs nginx 2>/dev/null | grep -q 'full site on\|^.*onchato-nginx: certificate found' && break
    curl -fsk --max-time 3 "https://$NODE_HOST/health" >/dev/null 2>&1 && break; sleep 4; done
}

# ---- 4. the key and the profile ------------------------------------------------
make_key() {
  [ "$KEY_MODE" = server ] || return 0
  if [ -f "$DATA/root.kdf" ]; then ok "the network key: $DATA/root.kdf (already there)"; return; fi
  say ""
  say "Choose the network key's passphrase: several unrelated words, 16+ characters."
  say "It IS the key - it cannot be changed later, and it is never stored."
  local tty=(-i); [ -t 0 ] && tty=(-it)
  ops "${tty[@]}" -- network key --passphrase-new /data/root.kdf || die "no key was made"
  say ""
  say "BACK UP NOW, separately from the passphrase: the file $DATA/root.kdf (its salt is private:"
  say "with it and the passphrase anyone can sign for your network; without it you cannot)."
}

write_profile() {
  export NETWORK_ID OPERATOR NODE_HOST HOME_URL APP_ORIGIN PEER_ID
  docker run --rm --user "$(id -u):$(id -g)" -v "$DATA:/data" -e NETWORK_ID -e OPERATOR -e NODE_HOST -e HOME_URL -e APP_ORIGIN -e PEER_ID \
    --entrypoint node onchato-ops -e '
    const fs = require("fs"), e = process.env
    const profile = { v: 1, networkId: e.NETWORK_ID, operator: e.OPERATOR,
      app: { origin: e.APP_ORIGIN, path: "/" }, stores: ["https://" + e.NODE_HOST],
      profileUrls: ["https://" + e.NODE_HOST + "/onchato/network.json"],
      feedback: null, home: e.HOME_URL, policy: { transport: "node-only" } }
    const nodes = { v: 1, nodes: [{ name: e.NODE_HOST, addr: "/dns4/" + e.NODE_HOST + "/tcp/443/wss/http-path/%2Frelay/p2p/" + e.PEER_ID }] }
    fs.writeFileSync("/data/profile/profile.json", JSON.stringify(profile, null, 2) + "\n")
    fs.writeFileSync("/data/profile/nodes.json", JSON.stringify(nodes, null, 2) + "\n")' || die "could not write the profile"
}

sign_profile() {
  write_profile
  if [ "$KEY_MODE" = server ]; then
    local tty=(-i); [ -t 0 ] && tty=(-it)
    { ops "${tty[@]}" -- network sign profile.json --nodes nodes.json --sign-passphrase /data/root.kdf --days 365 --out network.json \
      || die "the profile was not signed"; } | grep -v '^next:' 
  else
    say ""
    say "Sign the profile on your own computer (a checkout of $REPO_URL, Node 24):"
    say "  1. copy $DATA/profile/profile.json and nodes.json there"
    say "  2. node scripts/onchato-ops.mjs network sign profile.json --nodes nodes.json --sign-yubikey --out network.json"
    say "     (or --sign <keyfile>; keep using the SAME key every time)"
    say "  3. copy network.json back to $DATA/profile/network.json"
    if [ -t 0 ]; then read -r -p "Press Enter when network.json is in place... " _ || true; fi
    [ -f "$DATA/profile/network.json" ] || die "no $DATA/profile/network.json yet - run this again when it is there"
  fi
  chmod 644 "$DATA/profile/network.json"
}

# ---- 5. checks and the join code -----------------------------------------------
checks() {
  local k=; [ "$LOCAL_TEST" = 1 ] && k=-k
  say ""
  check "https://$NODE_HOST/health answers (DNS, TLS, nginx)" "curl -fs $k --max-time 5 https://$NODE_HOST/health"
  check "the relay takes a WebSocket (101)" "{ curl -s $k -i -N --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)' https://$NODE_HOST/relay || true; } | head -1 | grep -q ' 101'"
  check "STUN answers on 3478/udp" "docker run --rm --network host --entrypoint node onchato-ops /app/impl/net/stun-probe.ts ${STUN_HOST:-$NODE_HOST}"
  if [ -f "$DATA/profile/network.json" ]; then
    check "the network profile is served, signed, with CORS" "ops --network host -- network check network.json --online"
    ops -- network check network.json 2>/dev/null | grep -E 'valid|WARNING' || true
  else printf '[fail] no network profile yet\n'; bad=1; fi
}

join_code() {
  say ""
  ops -- network link "https://$NODE_HOST/onchato/network.json" network.json --svg join.svg | grep -v '^\[ok\] QR code in\|^The link names'
  local fp; fp=$(ops -- network check network.json 2>/dev/null | awk '/root key/ {print $3,$4,$5,$6,$7,$8,$9,$10}')
  say ""
  ok "the network $NETWORK_ID is running"
  say "     Operator key fingerprint: $fp  (people compare it when they join)"
  say "     QR code as a file: $DATA/profile/join.svg"
  say "     People join in the onchato app: sign-in screen, \"another network\", scan or paste the link above."
}

# ---- main ------------------------------------------------------------------------
load_answers
case "$MODE" in
  install)
    preflight; questions; dns_check; firewall; fetch_code; start_node; make_key; sign_profile; checks; join_code ;;
  check)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet (no $ETC/setup.env)"
    [ -n "${ONCHATO_SRC:-}" ] && DIR=$ONCHATO_SRC
    checks ;;
  update)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet"
    preflight; REF=${ONCHATO_REF:-__RELEASE_TAG__}; fetch_code; start_node; checks ;;
  renew)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet"
    [ -n "${ONCHATO_SRC:-}" ] && DIR=$ONCHATO_SRC
    PEER_ID=$(compose logs relay 2>/dev/null | grep -o 'PeerId: 12D3[A-Za-z0-9]*' | tail -1 | cut -d' ' -f2 || true)
    [ -n "$PEER_ID" ] || die "the relay is not running"
    sign_profile; checks; join_code
    say "A renewed profile has a new hash: print the new QR code above (the old one is refused)." ;;
esac
[ "$bad" = 0 ] || { say ""; die "some checks failed - see above"; }
