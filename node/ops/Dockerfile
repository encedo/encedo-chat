# onchato-ops on the server: sign, check and print the join code of the
# network profile (scripts/onchato-ops.mjs), and probe STUN, without Node or the
# repo's dependencies on the host. onchato-setup.sh runs it; context: repo root.
FROM node:24-bookworm-slim
WORKDIR /app
# The one dependency the profile code has: Ed25519 (@noble/curves), the
# version impl/ is locked to.
RUN mkdir -p impl && cd impl && printf '{"name":"onchato-ops","private":true,"type":"module","dependencies":{"@noble/curves":"1.9.7"}}\n' > package.json \
 && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY scripts/onchato-ops.mjs scripts/yubikey-sign.mjs scripts/
COPY scripts/lib/signer.mjs scripts/lib/
COPY impl/lib/netprofile.ts impl/lib/nodelist.ts impl/lib/cid.ts impl/lib/wc.ts impl/lib/qr.ts impl/lib/passmeter.ts impl/lib/
COPY impl/cli/termqr.ts impl/cli/
COPY impl/net/stun-probe.ts impl/net/
WORKDIR /work
ENTRYPOINT ["node", "/app/scripts/onchato-ops.mjs"]
