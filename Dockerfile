# onchato CLI as a container - the daemon for scripts and notifications, and
# the interactive client (CLI.md, chapter "Docker"). Only the CLI lives here;
# the web app and the relay are deployed otherwise (CLAUDE.md, Deploy).
#
#   docker build -t onchato .
#   docker run --rm -it -v onchato:/data onchato profile new bot     # once
#   docker run -d --name onchato -v onchato:/data \
#     --mount type=bind,src=$PWD/pass,dst=/run/secrets/onchato-password,ro \
#     onchato daemon
#   docker exec onchato onchato send ewa "backup gotowy"
#
# Node 24 runs the TypeScript sources directly (type stripping) - there is no
# build step, so the image carries the same files the repo does.
FROM node:24-bookworm-slim

# CREDENTIALS_DIRECTORY is a PATH, not a secret (docker build warns about the
# name): the CLI reads <dir>/onchato-password, as under systemd LoadCredential.
ENV NODE_ENV=production \
    ONCHATO_HOME=/data \
    ONCHATO_SOCKET=/data/onchato.sock \
    CREDENTIALS_DIRECTORY=/run/secrets \
    ONCHATO_DOWNLOADS=/data/downloads

WORKDIR /app
# Dependencies first, so a source change does not reinstall them.
COPY impl/package.json impl/package-lock.json impl/
RUN cd impl && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY hem-sdk-js/hem-sdk.js hem-sdk-js/LICENSE hem-sdk-js/
COPY infra/nodes.json infra/
# The client shares these two with the relay (net/light.ts, lib/nodepick.ts).
COPY relay/pick.mjs relay/load.mjs relay/
COPY LICENSE ./
COPY impl/cli impl/cli
COPY impl/lib impl/lib
COPY impl/net impl/net
COPY impl/eh2 impl/eh2
COPY impl/web/src/groupview.ts impl/web/src/

RUN chmod 755 impl/cli/onchato.ts && ln -s /app/impl/cli/onchato.ts /usr/local/bin/onchato \
 && mkdir -p /data && chown node:node /data

# Not root: the profile is the identity, and nothing here needs privileges.
# uid 1000 matches the usual first user on a host, which matters when /data
# is a bind mount rather than a named volume.
USER node
VOLUME ["/data"]
ENTRYPOINT ["onchato"]
CMD ["help"]
