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
# What it installs, and why: docs/OPERATOR.md and OPERATOR-NODE-PLAN.md in the
# repository. Answers are kept in /etc/onchato/setup.env; data in /var/lib/onchato;
# code in /opt/onchato. Code is ASCII (repo rule).
set -euo pipefail
# Files this script writes or clones are read by containers running as another
# user: a hardened umask (027, 077) made the relay unable to read its own code
# (found on the blbx.pl install).
umask 022

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
    docker buildx version >/dev/null 2>&1 || die "docker buildx is not available"
    return
  fi
  [ "$(id -u)" = 0 ] || die "run it as root: sudo bash $0"
  # Only these two fields: sourcing the whole file sets HOME_URL (and NAME,
  # VERSION...) over this script's own variables - every network set up on
  # Ubuntu got https://www.ubuntu.com/ as its home page (the blbx.pl install).
  [ -r /etc/os-release ] || die "cannot tell which system this is (/etc/os-release)"
  ID=$(. /etc/os-release && printf '%s' "${ID:-}")
  PRETTY_NAME=$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-}")
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
  # The system first: a fresh VPS image is often weeks behind, and a node faces
  # the internet. Upgraded without questions; a needed reboot is offered at the end.
  if [ "$ID" = ubuntu ] || [ "$ID" = debian ]; then
    say "Updating the system (apt upgrade)..."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq \
      && DEBIAN_FRONTEND=noninteractive apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade >/dev/null \
      || die "apt upgrade failed - run it by hand and look at the error"
    ok "the system is up to date"
  fi
  if sshd -T 2>/dev/null | grep -qx 'passwordauthentication yes'; then
    warn "SSH accepts passwords on this machine (some VPS images ship that way). Keys only is safer:"
    warn "  printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-local.conf && systemctl reload ssh"
  fi
  # buildx too: without it Docker falls back to the legacy builder, which ignores
  # the per-image node/**/Dockerfile.dockerignore and takes the CLI image's root
  # .dockerignore instead (found on bs4: the ops image missed its files).
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
    case "$ID" in
      ubuntu)
        say "Installing Docker from Ubuntu's own packages..."
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 docker-buildx git curl >/dev/null
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
  if [ -z "${FILES:-}" ]; then
    say ""
    say "Files and voice notes need a store (text and calls work without one)."
    say "  1) on this server (about 200 MB of RAM; files are deleted after 5 minutes)"
    say "  2) an existing store - you give its address, it is tested first"
    say "  3) none: text only"
    ask FILES_CHOICE "1, 2 or 3" "1"
    case "$FILES_CHOICE" in
      2) ask FILES "The store's address (e.g. https://onchato.com)" "" ;;
      3) FILES=none ;;
      *) FILES=here ;;
    esac
  fi
  case "$FILES" in
    here|none) ;;
    https://*|http://localhost*|http://127.0.0.1*)
      FILES=${FILES%/}
      local why; why=$(store_probe "$FILES") || die "the store at $FILES did not pass: $why - choose another, or 1/3"
      ok "the store at $FILES takes a file and gives it back the way the apps expect" ;;
    *) die "a store address must start with https:// (got: $FILES)" ;;
  esac
  if [ -z "${STATS:-}" ]; then
    say ""
    ask STATS_ANSWER "Keep statistics (connections and traffic per 15 minutes, 30 days, for a dashboard; Redis, a few MB)? y/n" "y"
    case "$STATS_ANSWER" in n|N|no|No) STATS=no ;; *) STATS=yes ;; esac
  fi
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
FILES='$FILES'
STATS='$STATS'
DOMAIN='$DOMAIN'
NETWORK_ID='$NETWORK_ID'
HOME_URL='$HOME_URL'
ENV
  chmod 600 "$ETC/setup.env"
}

# A store is what the apps can use when an upload to <origin>/f answers with a
# CID, and <origin>/f/<cid> gives the bytes back with the 8-byte prefix in front
# (the apps strip it when decrypting - infra/fput) and with the CORS and CORP
# headers a page on another origin needs. Prints the reason when it is not.
store_probe() {
  local url=${1%/} k= f got hdr resp cid
  [ "$LOCAL_TEST" = 1 ] && k=-k
  f=$(mktemp); got=$(mktemp); head -c 64 /dev/urandom > "$f"
  resp=$(curl -fsS $k -m 30 -H "Origin: $APP_ORIGIN" -F "file=@$f;filename=b;type=application/octet-stream" "$url/f" 2>/dev/null) \
    || { rm -f "$f" "$got"; echo "an upload to $url/f was refused"; return 1; }
  cid=$(printf '%s' "$resp" | grep -o '"Hash":"[^"]*"' | cut -d'"' -f4)
  [ -n "$cid" ] || { rm -f "$f" "$got"; echo "the upload answered without a CID"; return 1; }
  hdr=$(curl -fsS $k -m 30 -D - -o "$got" -H "Origin: $APP_ORIGIN" "$url/f/$cid" 2>/dev/null) \
    || { rm -f "$f" "$got"; echo "the download of $cid was refused"; return 1; }
  printf '%s' "$hdr" | grep -qi '^access-control-allow-origin: \*' || { rm -f "$f" "$got"; echo "the download has no CORS header"; return 1; }
  printf '%s' "$hdr" | grep -qi '^cross-origin-resource-policy: cross-origin' || { rm -f "$f" "$got"; echo "the download has no Cross-Origin-Resource-Policy"; return 1; }
  if [ "$(head -c 4 "$got")" != ECF1 ] || ! tail -c +9 "$got" | cmp -s - "$f"; then
    rm -f "$f" "$got"; echo "the store does not give the file back with the prefix the apps strip"; return 1
  fi
  rm -f "$f" "$got"
}

dns_check() {
  # The network page (access tier A: an open network, its join code public) on
  # the home domain - when that domain points at this server too. Elsewhere it
  # is the operator's own site and is left alone.
  HOME_SITE=
  if [ "$DOMAIN" != "$NODE_HOST" ] && [ "${HOME_URL%/}" = "https://$DOMAIN" ]; then
    if [ "$LOCAL_TEST" = 1 ]; then HOME_SITE=${ONCHATO_TEST_HOME_SITE:-}
    else
      local h; h=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')
      case " $(hostname -I 2>/dev/null) " in *" $h "*) [ -n "$h" ] && HOME_SITE=$DOMAIN ;; esac
    fi
  fi
  [ -n "$HOME_SITE" ] && ok "$HOME_SITE points here too: the network page will be served there"
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
$( [ "${STATS:-yes}" = yes ] && echo "REDIS_PORT=${REDIS_PORT:-6379}" )
DASH_PORT=${DASH_PORT:-8088}
$( [ "$LOCAL_TEST" = 1 ] && echo CERT_MODE=self )
$( [ "$LOCAL_TEST" = 0 ] && [ -n "${CERT_MODE:-}" ] && echo "CERT_MODE=$CERT_MODE" )
$( [ -n "${HOME_SITE:-}" ] && echo "HOME_SITE=$HOME_SITE" )
$( [ "${FILES:-}" = here ] && echo STORE=here )
COMPOSE_PROFILES=$( p=; [ "${FILES:-}" = here ] && p=store; [ "${STATS:-yes}" = yes ] && p=${p:+$p,}stats; echo "$p" )
$( [ -n "${PEERS:-}" ] && echo "PEERS=$PEERS" )
$( [ -n "${SIBLINGS:-}" ] && echo "SIBLINGS=$SIBLINGS" )
$( [ -n "${V6_HOST:-}" ] && echo "V6_HOST=$V6_HOST" )
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
  # The store the apps upload to: this node (here; and with none, where /f
  # simply answers 404 - the profile needs one), or the one tested above.
  case "${FILES:-here}" in here|none) STORE_ORIGIN="https://$NODE_HOST" ;; *) STORE_ORIGIN=$FILES ;; esac
  export NETWORK_ID OPERATOR NODE_HOST HOME_URL APP_ORIGIN PEER_ID STORE_ORIGIN
  docker run --rm --user "$(id -u):$(id -g)" -v "$DATA:/data" -e NETWORK_ID -e OPERATOR -e NODE_HOST -e HOME_URL -e APP_ORIGIN -e PEER_ID -e STORE_ORIGIN \
    --entrypoint node onchato-ops -e '
    const fs = require("fs"), e = process.env
    const profile = { v: 1, networkId: e.NETWORK_ID, operator: e.OPERATOR,
      app: { origin: e.APP_ORIGIN, path: "/" }, stores: [e.STORE_ORIGIN],
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

# The network page: the join code as a PNG and a page around it, from the
# template in the repo. Written again on --renew (a new signature, a new code).
write_site() {
  [ -n "${HOME_SITE:-}" ] || return 0
  mkdir -p "$DATA/profile/site"; chmod 755 "$DATA/profile/site"
  ops -- network link "https://$NODE_HOST/onchato/network.json" network.json --png site/join.png >/dev/null || die "the join code was not drawn"
  local fp; fp=$(ops -- network check network.json 2>/dev/null | awk '/root key/ {print $3,$4,$5,$6,$7,$8,$9,$10}')
  export OPERATOR NETWORK_ID NODE_HOST APP_ORIGIN FP="$fp"
  docker run --rm --user "$(id -u):$(id -g)" -v "$DATA:/data" -v "$DIR/node/site:/tpl:ro" \
    -e OPERATOR -e NETWORK_ID -e NODE_HOST -e APP_ORIGIN -e FP --entrypoint node onchato-ops -e '
    const fs = require("fs"), e = process.env
    const esc = (t) => String(t).replace(/[&<>"\x27]/g, (c) => "&#" + c.charCodeAt(0) + ";")
    const link = process.argv[1]
    const fp = e.FP.split(" ")
    const v = { OPERATOR: esc(e.OPERATOR), NETWORK_ID: esc(e.NETWORK_ID), NODE_HOST: esc(e.NODE_HOST),
      APP: esc(e.APP_ORIGIN + "/"), APP_HOST: esc(new URL(e.APP_ORIGIN).host),
      FP1: esc(fp.slice(0, 4).join(" ")), FP2: esc(fp.slice(4).join(" ")), LINK: esc(link) }
    const out = fs.readFileSync("/tpl/index.html", "utf8").replace(/__([A-Z0-9_]+)__/g, (m, k) => (k in v ? v[k] : m))
    fs.writeFileSync("/data/profile/site/index.html", out)' \
    "$(ops -- network link "https://$NODE_HOST/onchato/network.json" network.json | head -1)" || die "the network page was not written"
  chmod 644 "$DATA/profile/site/"*
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
  if [ "${STATS:-yes}" = yes ]; then
    check "statistics: Redis answers on loopback" "docker exec onchato-redis-1 redis-cli -p ${REDIS_PORT:-6379} ping | grep -q PONG"
  fi
  case "${FILES:-}" in
    here) local j; for j in $(seq 1 20); do store_probe "https://$NODE_HOST" >/dev/null && break; sleep 3; done
          check "files: the store on this node takes a file and gives it back prefixed" "store_probe https://$NODE_HOST" ;;
    none) warn "files: no store - text and calls only (re-run and choose 1 or 2 to add one)" ;;
    '') ;;
    *)    check "files: the store at $FILES still works" "store_probe $FILES" ;;
  esac
  local d; for d in $(seq 1 15); do curl -fs --max-time 3 "http://127.0.0.1:${DASH_PORT:-8088}/data" >/dev/null 2>&1 && break; sleep 2; done
  check "the dashboard answers on 127.0.0.1:${DASH_PORT:-8088} (SSH tunnel)" "curl -fs --max-time 5 http://127.0.0.1:${DASH_PORT:-8088}/data | grep -q onNode"
  if [ -n "${HOME_SITE:-}" ]; then
    local i; for i in $(seq 1 30); do curl -fs $k --max-time 5 "https://$HOME_SITE/join.png" >/dev/null 2>&1 && break; sleep 4; done
    check "the network page https://$HOME_SITE/ is served" "curl -fs $k --max-time 5 https://$HOME_SITE/ | grep -q onchato-net="
  fi
}

join_code() {
  say ""
  ops -- network link "https://$NODE_HOST/onchato/network.json" network.json --svg join.svg | grep -v '^\[ok\] QR code in\|^The link names'
  local fp; fp=$(ops -- network check network.json 2>/dev/null | awk '/root key/ {print $3,$4,$5,$6,$7,$8,$9,$10}')
  say ""
  ok "the network $NETWORK_ID is running"
  say "     Operator key fingerprint: $fp  (people compare it when they join)"
  say "     QR code as a file: $DATA/profile/join.svg"
  [ -n "${HOME_SITE:-}" ] && say "     The network page, with the code: https://$HOME_SITE/"
  say "     The operator's dashboard (this server only, through SSH):"
  say "       ssh -L ${DASH_PORT:-8088}:127.0.0.1:${DASH_PORT:-8088} root@$NODE_HOST    then open http://localhost:${DASH_PORT:-8088}"
  say "     People join in the onchato app: sign-in screen, \"another network\", scan or paste the link above."
}

# ---- main ------------------------------------------------------------------------
load_answers
case "$MODE" in
  install)
    preflight; questions; dns_check; firewall; fetch_code; start_node; make_key; sign_profile; write_site; checks; join_code ;;
  check)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet (no $ETC/setup.env)"
    [ -n "${ONCHATO_SRC:-}" ] && DIR=$ONCHATO_SRC
    dns_check >/dev/null; checks ;;
  update)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet"
    # dns_check: the home domain's network page, as at install - without it an
    # update dropped HOME_SITE and the page (found on blbx.pl, 0.7.59).
    preflight; dns_check; REF=${ONCHATO_REF:-__RELEASE_TAG__}; fetch_code; start_node; checks ;;
  renew)
    [ -n "${NODE_HOST:-}" ] || die "not set up yet"
    [ -n "${ONCHATO_SRC:-}" ] && DIR=$ONCHATO_SRC
    PEER_ID=$(compose logs relay 2>/dev/null | grep -o 'PeerId: 12D3[A-Za-z0-9]*' | tail -1 | cut -d' ' -f2 || true)
    [ -n "$PEER_ID" ] || die "the relay is not running"
    dns_check; sign_profile; write_site; checks; join_code
    say "A renewed profile has a new hash: print the new QR code above (the old one is refused)." ;;
esac
[ "$bad" = 0 ] || { say ""; die "some checks failed - see above"; }
if [ "$LOCAL_TEST" = 0 ] && [ -f /var/run/reboot-required ]; then
  say ""
  warn "the system update needs a reboot (a new kernel or library). The node comes back by itself."
  if [ -t 0 ]; then read -r -p "Reboot now? [y/N] " r || true; case "$r" in y|Y|yes) reboot ;; esac
  else say "Reboot when convenient: sudo reboot"; fi
fi
