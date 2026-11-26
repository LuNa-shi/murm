# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS filesystem-policy-build
RUN apt-get update \
  && apt-get install --no-install-recommends --yes gcc libc6-dev linux-libc-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=0:0 scripts/agent-filesystem-policy.c /tmp/agent-filesystem-policy.c
RUN cc -O2 -Wall -Wextra -Werror -o /agent-filesystem-policy /tmp/agent-filesystem-policy.c

FROM node:22.19.0-bookworm-slim AS typescript-build
WORKDIR /build
COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
COPY test-support/subagents/communication-fixture-prompts.ts ./test-support/subagents/
COPY services ./services
RUN npm run build

FROM node:22.19.0-bookworm-slim

ARG PI_VERSION=1.3.0
ARG CODEX_VERSION=0.172.0
LABEL org.murm.opensandbox.pi-version="${PI_VERSION}" \
      org.murm.opensandbox.codex-version="${CODEX_VERSION}" \
      org.murm.opensandbox.provider="kimi_proxy" \
      org.murm.opensandbox.worker-protocol="murm-core-v1"

RUN apt-get update \
  && apt-get install --no-install-recommends --yes bash ca-certificates curl git jq python3 python-is-python3 ripgrep util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/murm
COPY --chown=0:0 package.json npm-shrinkwrap.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm install --global --omit=dev --ignore-scripts --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
  && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}"

# Archive build contexts can carry the host checkout's UID and GID.
COPY --from=filesystem-policy-build --chown=0:0 /agent-filesystem-policy /opt/murm/agent-filesystem-policy
COPY --from=typescript-build --chown=0:0 /build/dist/src /opt/murm/dist/src
COPY --from=typescript-build --chown=0:0 \
  /build/dist/scripts/opensandbox-agent-worker.js /build/dist/scripts/sandbox-project.js \
  /build/dist/scripts/core-file-seed.js /build/dist/scripts/core-work-dir.js /build/dist/scripts/core-collection.js \
  /build/dist/scripts/rpc-submissions.js /build/dist/scripts/pi-rpc-submissions.js /build/dist/scripts/core-session-fork.js \
  /build/dist/scripts/codex-app-server-driver.js \
  /build/dist/scripts/project-install.js /build/dist/scripts/project-processes.js \
  /build/dist/scripts/swarm.js /build/dist/scripts/git-credential-peermesh.js /opt/murm/dist/scripts/
COPY --chown=0:0 services/opensandbox-agent/pi-models.json /opt/murm/pi-agent/models.json
# Git archives may mark source directories group-writable. Protect all
# compiled files and the parent directories checked by the worker.
RUN chmod 0755 /opt/murm \
  && chmod -R u=rwX,go=rX /opt/murm/dist \
  && chmod 0555 /opt/murm/dist/scripts/swarm.js \
  && chmod 0555 /opt/murm/dist/scripts/git-credential-peermesh.js \
  && git config --system credential.helper /opt/murm/dist/scripts/git-credential-peermesh.js \
  && git config --system credential.useHttpPath true \
  && ln -s /opt/murm/dist/scripts/swarm.js /usr/local/bin/swarm \
  && ln -s /opt/murm/dist/scripts/opensandbox-agent-worker.js /opt/murm/agent-worker.mjs \
  && ln -s /opt/murm/dist/scripts/sandbox-project.js /opt/murm/sandbox-project.mjs \
  && mkdir -p /workspace /opt/murm/pi-agent

ENV PATH="/opt/murm/node_modules/.bin:${PATH}" \
    PI_CODING_AGENT_DIR="/opt/murm/pi-agent" \
    MURM_PI_VERSION="${PI_VERSION}" \
    MURM_AGENT_WORKER="/opt/murm/agent-worker.mjs"

# The image contains the Worker, Pi and Codex CLIs, the Pi model catalog,
# shell tools and swarm CLI. Agent credentials are supplied at runtime.
ENTRYPOINT ["node", "/opt/murm/dist/scripts/opensandbox-agent-worker.js"]
