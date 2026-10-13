#!/usr/bin/env bash
# run.sh - every EH-2 scenario through ProVerif, each result checked against
# what it must be. Exit 1 on any mismatch, including a negative control that
# stops finding its attack. EH2-PROVERIF.md explains each line.
#
#   ./docs/proverif/run.sh            # needs `proverif` on PATH, or
#   PROVERIF="docker run --rm -v $PWD/docs/proverif:/w proverif-local" ./docs/proverif/run.sh
#
# Tested with ProVerif 2.05.
set -uo pipefail
cd "$(dirname "$0")"
PV=${PROVERIF:-proverif}
DIR=${PVDIR:-.}            # where the files are as the prover sees them (/w in docker)

# file | KEM library | expected RESULT values, in query order
SCENARIOS=(
  "eh2-auth|kem-public|false false true true"
  "eh2-secrecy|kem-ideal|true true"
  "eh2-fs|kem-ideal|true true"
  "eh2-kci|kem-public|true true false"
  "eh2-pq-dh-broken|kem-ideal|true true"
  "eh2-pq-kem-broken|kem-ideal|true true"
  "eh2-control-all-broken|kem-ideal|false false"
)
# The mutant: EH-2 without DH(EK_r, IK_i), built from eh2.pvl here and thrown
# away after. With that DH gone an attacker holding its own ephemeral derives
# SK without A's private key, so "R authenticates I" MUST fail - and does, in
# seconds. It proves the model can see a real protocol bug.
rm -rf mutant && mkdir mutant
sed -e 's/let ikm = (exp(pkR, eki), exp(ekR, ik), exp(ekR, eki), ss) in/let ikm = (exp(pkR, eki), exp(ekR, eki), ss) in/' \
    -e 's/let ikm = (exp(ekI, ik), exp(pkI, ekr), exp(ekI, ekr), ss) in/let ikm = (exp(ekI, ik), exp(ekI, ekr), ss) in/' eh2.pvl > mutant/eh2.pvl
if [ "$(grep -c 'exp(ekR, ik)\|exp(pkI, ekr)' mutant/eh2.pvl)" != 0 ]; then echo "[fail] the mutant was not built (eh2.pvl changed shape)"; exit 1; fi
cp eh2-auth.pv mutant/
SCENARIOS+=("mutant/eh2-auth|kem-public|false false false true|mutant/eh2")
trap 'rm -rf mutant' EXIT

fail=0
for s in "${SCENARIOS[@]}"; do
  IFS='|' read -r f kem want lib <<<"$s"
  lib=${lib:-eh2}
  t0=$(date +%s)
  got=$($PV -lib "$DIR/$kem" -lib "$DIR/$lib" "$DIR/$f.pv" 2>&1 | sed -n 's/^RESULT .* is \(true\|false\)\.$/\1/p' | tr '\n' ' ' | sed 's/ $//')
  dt=$(( $(date +%s) - t0 ))
  if [ "$got" = "$want" ]; then echo "[ok]   $f ($kem, ${dt}s): $got"
  else echo "[fail] $f ($kem, ${dt}s): got '$got', want '$want'"; fail=1; fi
done
exit $fail
