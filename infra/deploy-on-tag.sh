#!/bin/sh
# deploy-on-tag.sh — the host notices a release and builds it, on its own.
#
# ## Why the host asks, instead of CI telling it
#
# The other shape of this is a job in GitHub Actions that ssh's in and deploys.
# It is faster to write and it puts a key to production inside a runner: anyone
# who compromises the runner, or a workflow it trusts, has a shell here. This
# way round nothing outside holds a credential to this machine — the host reads
# a public repository and decides for itself. The cost is one timer interval of
# latency, and that is the whole cost.
#
# ## What counts as a release
#
# A TAG, and only a tag. `main` moves for reasons that are not releases, and a
# deploy per push would make "what is live" a question about timing. So: fast
# forward to origin/main, ask whether HEAD carries a `v*` tag, and build when
# that tag is one we have not built yet.
#
# ⚠️ Consequence, stated rather than discovered: tag the commit you want live
# and push both. A tag left BEHIND the tip is never seen, because HEAD will have
# moved past it — the check is "is HEAD tagged", not "is there a newer tag".
#
# The tree stays on `main` on purpose. Checking out the tag would leave the
# clone on a detached HEAD, and the next person to run the documented `git pull`
# by hand would be told they are not on a branch — a trap set by a timer they
# did not know was running.
#
# ## What it refuses to do
#
# The relay is NOT restarted here. It is a live service with connected clients
# and its own deploy in CLAUDE.md; a timer that restarts it silently would make
# every release a brief outage nobody chose. If a release touches `relay/`, that
# is a deliberate act on a keyboard.
#
# Install: see infra/README.md.

set -eu

REPO="${REPO:-/opt/github/encedo-chat}"
STATE="${STATE:-/var/lib/onchato-deployed-tag}"
say() { logger -t onchato-deploy "$*"; echo "$*"; }

cd "$REPO"

# One at a time. A build takes minutes and the timer does not care.
exec 9>"${LOCK:-/var/lock/onchato-deploy.lock}"
if ! flock -n 9; then say "another deploy is running — skipping"; exit 0; fi

git fetch --quiet --tags --prune origin
# Told apart from the merge below on purpose: a clone that tracks another branch
# (or is not this project at all) and a tree that has diverged are two different
# mistakes, and one message for both sends the reader to the wrong place.
if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  say "no origin/main in $REPO — wrong clone, or the branch was renamed"
  exit 1
fi

# --ff-only: if the tree has local commits or a conflicting history, stop and say
# so. A deploy script is the wrong place to resolve that, and merging by itself
# is how a host ends up running something nobody wrote.
if ! git merge --quiet --ff-only origin/main 2>/dev/null; then
  say "cannot fast-forward to origin/main — deploy skipped, look at $REPO by hand"
  exit 1
fi

TAG=$(git tag --points-at HEAD --list 'v*' | sort -V | tail -1)
[ -n "$TAG" ] || exit 0                      # tip is not a release; nothing to do
LAST=$(cat "$STATE" 2>/dev/null || echo '')
[ "$TAG" != "$LAST" ] || exit 0              # already built this one

say "new release $TAG — building"
git submodule update --init --recursive --quiet

# The hash BEFORE, so "it deployed" can be a fact rather than an impression.
# index.html is not hashed but the bundle is, so a build that produced nothing
# new leaves this string unchanged — which is exactly the failure the deploy
# notes in CLAUDE.md warn about, and it has happened.
DIST="$REPO/impl/web/dist"
BEFORE=$(grep -o 'app\.[a-z0-9]*\.bundle\.js' "$DIST/index.html" 2>/dev/null | head -1 || true)

if ! (cd impl && npm run web:deploy >/tmp/onchato-deploy.log 2>&1); then
  say "BUILD FAILED for $TAG — see /tmp/onchato-deploy.log; nothing was recorded"
  exit 1
fi

AFTER=$(grep -o 'app\.[a-z0-9]*\.bundle\.js' "$DIST/index.html" | head -1)
if [ -z "$AFTER" ] || [ ! -f "$DIST/$AFTER" ]; then
  say "BUILD SAID OK but $DIST/index.html points at nothing that exists — NOT recording $TAG"
  exit 1
fi

# The state file is written LAST and only after the checks above. A failed build
# must be retried on the next tick, not remembered as done.
echo "$TAG" > "$STATE"
if [ "$BEFORE" = "$AFTER" ]; then
  say "deployed $TAG — bundle unchanged ($AFTER), which is normal when a release touches no web code"
else
  say "deployed $TAG — bundle $BEFORE -> $AFTER"
fi
