# onchato-node - one image for a node's relay and STUN (OPERATOR-NODE-PLAN.md).
# Built on the server from a release tag, no registry; the context is the repo
# root (the relay, STUN and the geoip matcher live in different directories):
#
#   docker build -f node/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t onchato-node .
#
# The compose file next to this one runs it twice (relay, stun) beside nginx,
# certbot and Redis. No build step: the relay is plain .mjs.
#
# Node 22, as on bs1-bs3 (relay/DEPLOY.md step 2), and NOT 24: @libp2p/crypto
# 5.x derives an Ed25519 public key from a JWK with `x: ''`, which Node 24.22
# refuses (ERR_CRYPTO_INVALID_JWK) - the relay dies at start. Found 2026-10-18
# building this image; move only together with a libp2p that does not do that.
FROM node:22-bookworm-slim
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
# Dependencies first, so a source change does not reinstall them.
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay/*.mjs relay/
COPY infra/stun/stun.mjs infra/stun/
COPY infra/geoip/geoip.mjs infra/geoip/
COPY node/entry.sh /usr/local/bin/onchato-node
RUN chmod 755 /usr/local/bin/onchato-node && mkdir -p /data && chown node:node /data
USER node
ENTRYPOINT ["onchato-node"]
CMD ["relay"]
