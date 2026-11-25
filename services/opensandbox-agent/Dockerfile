# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS filesystem-policy-build
RUN apt-get update \
  && apt-get install --no-install-recommends --yes gcc libc6-dev linux-libc-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=0:0 scripts/bot-filesystem-policy.c /tmp/bot-filesystem-policy.c
RUN cc -O2 -Wall -Wextra -Werror -o /bot-filesystem-policy /tmp/bot-filesystem-policy.c

FROM node:22.19.0-bookworm-slim AS typescript-build
WORKDIR /build
COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
COPY services ./services
RUN npm run build

FROM node:22.19.0-bookworm-slim

ARG PI_VERSION=1.3.0
LABEL org.swarmenv.opensandbox.pi-version="${PI_VERSION}" \
      org.swarmenv.opensandbox.provider="kimi_proxy"

RUN apt-get update \
  && apt-get install --no-install-recommends --yes bash ca-certificates curl git jq python3 python-is-python3 ripgrep util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/swarmenv
COPY --chown=0:0 package.json npm-shrinkwrap.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# Archive build contexts can carry the host checkout's UID and GID.
COPY --from=filesystem-policy-build --chown=0:0 /bot-filesystem-policy /opt/swarmenv/bot-filesystem-policy
COPY --from=typescript-build --chown=0:0 /build/dist/src /opt/swarmenv/dist/src
COPY --from=typescript-build --chown=0:0 \
  /build/dist/scripts/opensandbox-agent-worker.js /build/dist/scripts/sandbox-project.js \
  /build/dist/scripts/core-file-seed.js /build/dist/scripts/core-work-dir.js /build/dist/scripts/core-collection.js \
  /build/dist/scripts/pi-rpc-submissions.js /build/dist/scripts/core-session-fork.js \
  /build/dist/scripts/project-install.js /build/dist/scripts/project-processes.js \
  /build/dist/scripts/swarm.js /build/dist/scripts/git-credential-agensh.js /opt/swarmenv/dist/scripts/
COPY --chown=0:0 services/opensandbox-agent/pi-models.json /opt/swarmenv/pi-agent/models.json
# Git archives may mark source directories group-writable. Protect all
# compiled files and the parent directories checked by the worker.
RUN chmod 0755 /opt/swarmenv \
  && chmod -R u=rwX,go=rX /opt/swarmenv/dist \
  && chmod 0555 /opt/swarmenv/dist/scripts/swarm.js \
  && chmod 0555 /opt/swarmenv/dist/scripts/git-credential-agensh.js \
  && git config --system credential.helper /opt/swarmenv/dist/scripts/git-credential-agensh.js \
  && git config --system credential.useHttpPath true \
  && ln -s /opt/swarmenv/dist/scripts/swarm.js /usr/local/bin/swarm \
  && ln -s /opt/swarmenv/dist/scripts/opensandbox-agent-worker.js /opt/swarmenv/agent-worker.mjs \
  && ln -s /opt/swarmenv/dist/scripts/sandbox-project.js /opt/swarmenv/sandbox-project.mjs \
  && mkdir -p /workspace /opt/swarmenv/pi-agent

ENV PATH="/opt/swarmenv/node_modules/.bin:${PATH}" \
    PI_CODING_AGENT_DIR="/opt/swarmenv/pi-agent" \
    SWARMENV_PI_VERSION="${PI_VERSION}" \
    SWARMENV_AGENT_WORKER="/opt/swarmenv/agent-worker.mjs"

# The image contains the worker, native Pi package, direct Pi model catalog,
# shell tools and swarm CLI. Credentials are supplied only at runtime.
ENTRYPOINT ["node", "/opt/swarmenv/dist/scripts/opensandbox-agent-worker.js"]
