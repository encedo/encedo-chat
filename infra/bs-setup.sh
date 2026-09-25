#!/usr/bin/env bash
# infra/bs-setup.sh -- stand up, or check, one onchato relay node (bsN).
#
#   bs-setup.sh --check                        # this machine vs the template in the repo; changes NOTHING
#   bs-setup.sh --dry-run --host bs4.onchato.com   # every question, every file, every command -- runs none
#   bs-setup.sh --host bs4.onchato.com         # install
#
# Options: --host <name>        the node's public name; also its --pass, i.e. its PeerId (never change it)
#          --max-conns <n>      default from the node table, else from cores: 400 (1-2 vCPU, measured
#                               2026-09-25), 800 on 4+ vCPU until its own load test
#          --max-topics <n>     default: the node table, else 4 x --max-conns
#          --push-url <url>     Uptime Kuma push URL for the health timer (else the timer is left off)
#          --no-cert            skip certbot + the nginx site (a test box without DNS)
#          --skip-dns-check     do not require the A record to point at this machine
#          --repo <dir>         clone location (default /opt/github/encedo-chat)
#
# What it installs is what relay/DEPLOY.md describes step by step; the WHY of
# every setting lives there, not here. The relay's flags come from ONE place,
# relay/onchato-relay.service, and so does the list of existing nodes (the
# table at its bottom): this script renders that template, it does not carry a
# second copy of it. `--check` is the same render compared with what systemd
# actually runs -- the drift that once left 13 flags living only on machines.
#
# What it does NOT do, on purpose (relay/DEPLOY.md, BS-SETUP-PLAN.md):
#   - publish the node: infra/nodes.json is a client release, a decision;
#   - touch the OTHER nodes: all-to-all mesh means each of them must add this
#     one to --peers/--siblings and ufw -- the script prints those lines;
#   - touch any nginx site but its own (bs2 serves foreign domains);
#   - the web, IPFS store, MQTT and feedback roles (bs1 only; infra/README.md).
#
# Code is ASCII (repo rule): no glyphs in output.

set -euo pipefail

MODE=install
HOST=""
MAXT=""
MAXC=""
PUSH_URL=""
NO_CERT=0
SKIP_DNS=0
REPO=/opt/github/encedo-chat
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC_REPO=$(cd "$SCRIPT_DIR/.." && pwd)     # the checkout this script was run from

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --dry-run) MODE=dry ;;
    --host) HOST="$2"; shift ;;
    --max-topics) MAXT="$2"; shift ;;
    --max-conns) MAXC="$2"; shift ;;
    --push-url) PUSH_URL="$2"; shift ;;
    --no-cert) NO_CERT=1 ;;
    --skip-dns-check) SKIP_DNS=1 ;;
    --repo) REPO="$2"; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO=sudo
say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; WARNED=1; }
bad()  { printf '  [fail] %s\n' "$*"; FAILED=1; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
WARNED=0; FAILED=0

# In --dry-run every side effect is printed instead of performed.
run() {
  if [ "$MODE" = dry ]; then printf '  $ %s\n' "$*"; else eval "$@"; fi
}
# Write stdin to a root-owned file (printed, not written, in --dry-run).
put() {
  local dest=$1 mode=${2:-644} tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ "$MODE" = dry ]; then
    printf '  --- %s (%s) ---\n' "$dest" "$mode"; sed 's/^/  | /' "$tmp"
  else
    $SUDO install -m "$mode" -o root -g root "$tmp" "$dest"
  fi
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# The node table and the template, read from the repo
# ---------------------------------------------------------------------------
TEMPLATE_REPO=$REPO
[ -f "$TEMPLATE_REPO/relay/onchato-relay.service" ] || TEMPLATE_REPO=$SRC_REPO
TEMPLATE=$TEMPLATE_REPO/relay/onchato-relay.service
[ -f "$TEMPLATE" ] || die "no relay/onchato-relay.service in $REPO or $SRC_REPO"

# Rows look like:  # bs1   12D3KooW...   2a03:ec41:0:9::cf   2 GB  2000
# name, PeerId, mesh IPv6, --max-topics, --max-connections
table() { { grep -E '^# bs[0-9]+ +12D3KooW' "$TEMPLATE" || true; } | awk '{print $2, $3, $4, $7, $8}'; }
# An old clone carries the 3-flag template with no node table: say so instead of
# rendering nonsense (or, under `set -e`, dying without a word).
[ -n "$(table)" ] || die "$TEMPLATE has no node table -- the clone predates it: git -C $TEMPLATE_REPO pull --ff-only"

short=${HOST%%.*}
if [ -z "$HOST" ]; then
  if [ "$MODE" = check ]; then
    # On an existing node the answer is in systemd already.
    HOST=$(systemctl show -p ExecStart --value onchato-relay 2>/dev/null | grep -o -- '--host [^ ]*' | awk '{print $2}' || true)
  fi
  if [ -z "$HOST" ] && [ -t 0 ]; then read -r -p "Node name (e.g. bs4.onchato.com): " HOST; fi
  [ -n "$HOST" ] || die "--host is required"
  short=${HOST%%.*}
fi
[[ "$HOST" =~ ^bs[0-9]+\.onchato\.com$ ]] || warn "$HOST does not look like bsN.onchato.com -- the name is also the PeerId seed"

V6=$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2}' | cut -d/ -f1 | grep -v '^fd' | head -1 || true)
RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
CPUS=$(nproc 2>/dev/null || echo 1)
if [ -z "$MAXC" ]; then
  row_maxc=$(table | awk -v n="$short" '$1==n{print $5}')
  if [ -n "$row_maxc" ]; then MAXC=$row_maxc
  elif [ "$CPUS" -ge 4 ]; then MAXC=800; else MAXC=400; fi
fi
if [ -z "$MAXT" ]; then
  row_maxt=$(table | awk -v n="$short" '$1==n{print $4}')
  if [ -n "$row_maxt" ]; then MAXT=$row_maxt; else MAXT=$(( MAXC * 4 )); fi
fi

PEERS=""; SIBLINGS=""
while read -r name pid v6 _; do
  [ "$name" = "$short" ] && continue
  PEERS="$PEERS /ip6/$v6/tcp/9002/ws/p2p/$pid"
  SIBLINGS="$SIBLINGS,$pid"
done < <(table)
PEERS=${PEERS# }; SIBLINGS=${SIBLINGS#,}

# Only the two lines that carry fields are filled: the comments name the same
# fields (<V6>, <PEERS>...) as documentation and must stay readable.
render_unit() {
  sed -E "/^(ExecStart|Description)=/{s|<NODE>|$short|g; s|<V6>|$V6|; s|<PEERS>|$PEERS|; s|<SIBLINGS>|$SIBLINGS|; s|<MAX_TOPICS>|$MAXT|; s|<MAX_CONNS>|$MAXC|}" "$TEMPLATE"
}
# One flag (with its values) per line, sorted: comparable whatever the order.
flags() {
  tr ' ' '\n' | grep -v '^$' \
    | awk 'BEGIN{k=""} /^--/{if(k!="")print k; k=$0; next} {k=k" "$0} END{if(k!="")print k}' | sort
}

# ---------------------------------------------------------------------------
# --check: this machine against the template. Changes nothing.
# ---------------------------------------------------------------------------
if [ "$MODE" = check ]; then
  say "$HOST  (template: $TEMPLATE)"
  row=$(table | awk -v n="$short" '$1==n')
  [ -n "$row" ] && ok "listed in the node table: $row" || warn "$short is not in the node table of the template"

  want=$(render_unit | grep '^ExecStart=/' | sed 's|^ExecStart=/usr/bin/node relay.mjs ||' | flags)
  live=$(systemctl show -p ExecStart --value onchato-relay 2>/dev/null \
    | sed -E 's/.*argv\[\]=\/usr\/bin\/node relay.mjs //; s/ ;.*//' | flags)
  if [ -z "$live" ]; then bad "onchato-relay is not installed"
  elif [ "$want" = "$live" ]; then ok "relay flags identical to the template ($(printf '%s\n' "$want" | wc -l) flags)"
  else
    bad "relay flags differ from the template (< template, > live):"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$live") | grep '^[<>]' | sed 's/^/           /' || true
  fi
  [ -z "$(ls /etc/systemd/system/onchato-relay.service.d 2>/dev/null)" ] && ok "no drop-in overriding the unit" \
    || warn "a drop-in overrides the unit: /etc/systemd/system/onchato-relay.service.d"

  for u in onchato-relay onchato-stun redis-server; do
    systemctl is-active --quiet "$u" && ok "$u active" || bad "$u not active"
  done
  systemctl is-active --quiet onchato-health.timer && ok "health timer active" || warn "health timer not active"
  [ "$(redis-cli ping 2>/dev/null)" = PONG ] && ok "redis answers" || bad "redis does not answer"
  mm=$(redis-cli config get maxmemory 2>/dev/null | tail -1); mp=$(redis-cli config get maxmemory-policy 2>/dev/null | tail -1)
  [ "$mm" = 67108864 ] && [ "$mp" = volatile-ttl ] && ok "redis 64 MB, volatile-ttl" || warn "redis maxmemory=$mm policy=$mp (want 64 MB, volatile-ttl)"

  estab=$(ss -tn state established '( sport = :9002 or dport = :9002 )' | tail -n +2 | wc -l)
  expect=$(table | awk -v n="$short" '$1!=n' | wc -l)
  [ "$estab" -ge "$expect" ] && ok "mesh: $estab link(s) on 9002, $expect other node(s)" || bad "mesh: $estab link(s) on 9002, expected $expect"
  L9002=$(ss -ltn '( sport = :9002 )' | tail -n +2)
  [ -n "$L9002" ] && ok "listening on 9002 (mesh)" || bad "not listening on 9002"
  UFW=$($SUDO ufw status 2>/dev/null || true)
  while read -r name _ v6 _; do
    [ "$name" = "$short" ] && continue
    printf '%s\n' "$UFW" | grep -q "9002/tcp.*ALLOW.*$v6" && ok "ufw 9002 open to $name ($v6)" || bad "ufw 9002 NOT open to $name ($v6)"
  done < <(table)
  printf '%s\n' "$UFW" | grep -qE '^9001' && bad "9001 is open in ufw -- a door around nginx" || ok "9001 not exposed"

  if [ -f "/etc/letsencrypt/live/$HOST/fullchain.pem" ]; then
    end=$($SUDO openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$HOST/fullchain.pem" | cut -d= -f2)
    days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    [ "$days" -gt 14 ] && ok "certificate valid $days more day(s)" || warn "certificate expires in $days day(s)"
  else
    [ "$short" = bs1 ] && ok "certificate: bs1 shares the web host's (not checked here)" || warn "no certificate for $HOST"
  fi
  $SUDO nginx -t >/dev/null 2>&1 && ok "nginx -t passes" || bad "nginx -t fails"
  # Each WebSocket holds TWO nginx connections (client + upstream). The default
  # 768 capped a node at ~380 clients before the relay's own limit (2026-09-25).
  WC=$(grep -oE 'worker_connections[[:space:]]+[0-9]+' /etc/nginx/nginx.conf 2>/dev/null | grep -oE '[0-9]+' | head -1)
  [ -n "$WC" ] && [ "$WC" -ge $(( MAXC * 5 / 2 )) ] && ok "nginx worker_connections $WC carries $MAXC clients" \
    || bad "nginx worker_connections ${WC:-?} < 2.5 x $MAXC -- nginx refuses clients before the relay does"
  [ -z "$(ls /etc/nginx/sites-enabled/ 2>/dev/null | grep -E '\.(bak|orig|old)|~$')" ] && ok "no backup files in sites-enabled" \
    || bad "backup file in sites-enabled -- nginx LOADS it"

  # The banner is printed once, at start: read from the start of THIS run.
  since=$(systemctl show onchato-relay -p ActiveEnterTimestamp --value 2>/dev/null)
  lim=$({ $SUDO journalctl -u onchato-relay --since "$since" --no-pager 2>/dev/null || true; } | { grep -o 'Tematy: limit [0-9]*' || true; } | tail -1)
  [ -n "$lim" ] && ok "running with '$lim' (template: $MAXT)" || warn "could not read the topic limit from the journal"
  echo
  if [ "$FAILED" != 0 ]; then say "RESULT: DIFFERS -- see [fail] lines"
  elif [ "$WARNED" != 0 ]; then say "RESULT: matches the template (with warnings)"
  else say "RESULT: matches the template"; fi
  [ "$FAILED" = 0 ]; exit $?
fi

# ---------------------------------------------------------------------------
# --dry-run / install
# ---------------------------------------------------------------------------
[ "$MODE" = dry ] && say "DRY RUN -- nothing below is executed or written." && echo
say "node      $HOST"
say "mesh v6   ${V6:-<none found>}"
say "machine   $CPUS vCPU, $RAM_MB MB -> --max-connections $MAXC, --max-topics $MAXT"
say "peers     ${PEERS:-<none: this is the first node>}"
echo
if [ -z "$V6" ]; then
  [ "$MODE" = dry ] || die "no global IPv6 on this machine: the mesh runs over IPv6 port 9002 (relay/DEPLOY.md step 1)"
  V6="THIS-MACHINE-IPV6"; warn "no global IPv6 here -- shown as $V6 (a real install refuses)"
fi
table | awk -v n="$short" '$1==n' | grep -q . && [ "$MODE" = install ] && \
  warn "$short is ALREADY in the node table -- is this a rebuild of an existing node? (Ctrl-C to stop)"

# -- 0. DNS must name THIS machine (the wildcard would resolve to bs1) --------
say "== 0. DNS"
if [ "$SKIP_DNS" = 1 ] || [ "$NO_CERT" = 1 ]; then warn "DNS check skipped"
else
  a=$(getent ahostsv4 "$HOST" | awk '{print $1; exit}' || true)
  mine=$(hostname -I 2>/dev/null || true)
  if [ -n "$a" ] && printf '%s\n' $mine | grep -qx "$a"; then ok "$HOST -> $a (this machine)"
  else
    msg="$HOST resolves to '${a:-nothing}', not to this machine ($mine). Create the A record first -- the wildcard *.onchato.com points at bs1."
    [ "$MODE" = dry ] && warn "$msg" || die "$msg"
  fi
fi

# -- 1. packages ---------------------------------------------------------------
say "== 1. packages"
run "$SUDO apt-get update -q"
run "$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -q ufw curl git jq ca-certificates gnupg redis-server"
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  run "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg"
  printf 'Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' \
    "$(dpkg --print-architecture)" | put /etc/apt/sources.list.d/nodesource.sources
  run "$SUDO apt-get update -q && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs"
else ok "node $(node -v) already there"; fi
[ "$NO_CERT" = 1 ] || run "$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -q nginx certbot"

# -- 2. firewall: 22/80/443, 3478/udp, 9002 from the other nodes only ----------
say "== 2. firewall"
run "$SUDO ufw default deny incoming"
run "$SUDO ufw default allow outgoing"
run "$SUDO ufw allow OpenSSH"
run "$SUDO ufw allow 80/tcp"
run "$SUDO ufw allow 443/tcp"
run "$SUDO ufw allow 3478/udp comment 'STUN'"
while read -r name _ v6 _; do
  [ "$name" = "$short" ] && continue
  run "$SUDO ufw allow from $v6 to any port 9002 proto tcp comment '$name relay mesh over IPv6'"
done < <(table)
run "$SUDO ufw --force enable"

# -- 3. the code -----------------------------------------------------------------
say "== 3. code in $REPO"
if [ -d "$REPO/.git" ]; then ok "clone exists"
else
  run "$SUDO mkdir -p $(dirname "$REPO")"
  run "$SUDO git clone -q https://github.com/encedo/encedo-chat.git $REPO"
fi
run "(cd $REPO/relay && $SUDO npm ci --silent)"

# The PeerId this name seeds -- what every client will carry. Printed now so
# the operator can compare it with the log at step 5.
if [ -d "$REPO/relay/node_modules/@libp2p/crypto" ] || [ -d "$SRC_REPO/relay/node_modules/@libp2p/crypto" ]; then
  d=$REPO/relay; [ -d "$d/node_modules/@libp2p/crypto" ] || d=$SRC_REPO/relay
  PID=$(cd "$d" && node -e '
    import("@libp2p/crypto/keys").then(async ({generateKeyPairFromSeed}) => {
      const {peerIdFromPrivateKey} = await import("@libp2p/peer-id")
      const {createHash} = await import("node:crypto")
      const key = await generateKeyPairFromSeed("Ed25519", createHash("sha256").update(process.argv[1]).digest())
      console.log(peerIdFromPrivateKey(key).toString())
    })' "$HOST")
  say "  PeerId of $HOST: $PID"
else PID="<computed after npm ci>"; say "  PeerId: computed once the clone is installed"; fi

# -- 4. Redis for the statistics (loopback, 64 MB, volatile-ttl) -----------------
say "== 4. redis"
run "$SUDO sed -i -E 's/^#? *maxmemory .*/maxmemory 64mb/; s/^#? *maxmemory-policy .*/maxmemory-policy volatile-ttl/' /etc/redis/redis.conf"
run "$SUDO systemctl enable -q --now redis-server && $SUDO systemctl restart redis-server"

# -- 5. the relay: the template, filled ------------------------------------------
say "== 5. relay"
unit=$(render_unit)
printf '%s\n' "$unit" | grep -qE '^(ExecStart|Description)=.*<' && die "template left unfilled fields -- check the node table"
printf '%s\n' "$unit" | put /etc/systemd/system/onchato-relay.service
run "$SUDO systemctl daemon-reload"
run "$SUDO systemctl enable -q --now onchato-relay"

# -- 6. STUN -------------------------------------------------------------------------
say "== 6. stun"
run "$SUDO install -m 644 $REPO/infra/stun/onchato-stun.service /etc/systemd/system/onchato-stun.service"
run "$SUDO systemctl daemon-reload && $SUDO systemctl enable -q --now onchato-stun"

# -- 7. health push ---------------------------------------------------------------
say "== 7. health"
run "$SUDO install -D -m 755 $REPO/infra/health/relay-health.sh /usr/local/lib/onchato/relay-health.sh"
run "$SUDO install -m 644 $REPO/infra/health/onchato-health.service $REPO/infra/health/onchato-health.timer /etc/systemd/system/"
if [ -n "$PUSH_URL" ]; then
  printf 'PUSH_URL=%s\n' "$PUSH_URL" | put /etc/onchato-health.env 600
  run "$SUDO systemctl daemon-reload && $SUDO systemctl enable -q --now onchato-health.timer"
else
  warn "no --push-url: health timer installed but NOT enabled (infra/health/README.md)"
fi

# -- 8. certificate + this node's own nginx site ------------------------------------
if [ "$NO_CERT" = 1 ]; then
  say "== 8. certificate + nginx: skipped (--no-cert)"
else
  say "== 8. certificate + nginx"
  run "$SUDO certbot certonly --webroot -w /var/www/html -d $HOST --agree-tos --register-unsafely-without-email --non-interactive --deploy-hook 'systemctl reload nginx'"
  run "$SUDO install -m 644 $REPO/infra/nginx/relay-limits.conf /etc/nginx/conf.d/relay-limits.conf"
  # Two nginx connections per client: the stock 768 is a ~380-client ceiling.
  run "$SUDO sed -i -E 's/worker_connections [0-9]+;/worker_connections 4096;/' /etc/nginx/nginx.conf"
  run "grep -q worker_rlimit_nofile /etc/nginx/nginx.conf || $SUDO sed -i -E 's/^(worker_processes [^;]+;)/\\1\\nworker_rlimit_nofile 8192;/' /etc/nginx/nginx.conf"
  sed "s/__HOST__/$HOST/g" "$TEMPLATE_REPO/infra/nginx/relay-node.conf" | put "/etc/nginx/sites-available/$HOST"
  run "$SUDO ln -sf /etc/nginx/sites-available/$HOST /etc/nginx/sites-enabled/$HOST"
  run "$SUDO nginx -t && $SUDO systemctl reload nginx"
fi

# -- 9. what the operator does next, elsewhere ---------------------------------------
echo
say "== done on this machine. Next, NOT done by this script:"
say "1. Check the relay log: the PeerId must be $PID"
say "     journalctl -u onchato-relay -n 25 --no-pager"
say "2. On EACH existing node (all-to-all mesh), then restart it:"
say "     sudo ufw allow from $V6 to any port 9002 proto tcp comment '$short relay mesh over IPv6'"
say "     sudo sed -i 's|--peers |--peers /ip6/$V6/tcp/9002/ws/p2p/$PID |; s|--siblings |--siblings $PID,|' /etc/systemd/system/onchato-relay.service"
say "3. In the repo: add the row to relay/onchato-relay.service"
say "     # $short   $PID     $V6   $(( (RAM_MB + 512) / 1024 )) GB  $MAXT  $MAXC"
say "4. Then: bs-setup.sh --check here, net/light-test.ts and net/second-joiner.ts against it,"
say "   and publishing (infra/nodes.json) only once it answers -- relay/DEPLOY.md step 9."
