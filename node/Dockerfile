# onchato-node - one image for a node's relay, STUN and upload prefixer (OPERATOR-NODE-PLAN.md).
# Built on the server from a release tag, no registry; the context is the repo
# root (the relay, STUN and the geoip matcher live in different directories):
#
#   docker build -f node/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t onchato-node .
#
# The compose file next to this one runs it twice (relay, stun) beside nginx,
# certbot and Redis. No build step: the relay is plain .mjs. Node 24, as the
# CLI image and CI (relay/nodekey.mjs: why the relay builds its key itself).
FROM node:24-bookworm-slim
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
# Dependencies first, so a source change does not reinstall them.
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay/*.mjs relay/
COPY infra/stun/stun.mjs infra/stun/
COPY infra/geoip/geoip.mjs infra/geoip/
# The file store's upload prefixer (STORE=here): the same service as onchato.com's.
COPY infra/fput/fput.mjs infra/fput/prefix.mjs infra/fput/
COPY impl/lib/fileenvelope.ts impl/lib/
COPY node/entry.sh /usr/local/bin/onchato-node
# Readable by the `node` user whatever umask the server cloned the code with
# (a hardened 077 left the relay unable to open relay.mjs: EACCES).
RUN chmod -R a+rX /app && chmod 755 /usr/local/bin/onchato-node && mkdir -p /data && chown node:node /data
USER node
ENTRYPOINT ["onchato-node"]
CMD ["relay"]
