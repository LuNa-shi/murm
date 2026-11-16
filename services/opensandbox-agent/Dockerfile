# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim AS filesystem-policy-build
RUN apt-get update \
  && apt-get install --no-install-recommends --yes gcc libc6-dev linux-libc-dev \
  && rm -rf /var/lib/apt/lists/*
COPY --chown=0:0 scripts/bot-filesystem-policy.c /tmp/bot-filesystem-policy.c
RUN cc -O2 -Wall -Wextra -Werror -o /bot-filesystem-policy /tmp/bot-filesystem-policy.c

FROM node:22.19.0-bookworm-slim

ARG PI_VERSION=1.3.0
LABEL org.swarmenv.opensandbox.pi-version="${PI_VERSION}" \
      org.swarmenv.opensandbox.provider="gpt_proxy"

RUN apt-get update \
  && apt-get install --no-install-recommends --yes bash ca-certificates git util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/swarmenv
COPY --chown=0:0 package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

# Archive build contexts can carry the host checkout's UID and GID.
COPY --from=filesystem-policy-build --chown=0:0 /bot-filesystem-policy /opt/swarmenv/bot-filesystem-policy
COPY --chown=0:0 scripts/opensandbox-agent-worker.mjs /opt/swarmenv/agent-worker.mjs
COPY --chown=0:0 scripts/sandbox-project.mjs /opt/swarmenv/sandbox-project.mjs
COPY --chown=0:0 scripts/project-install.mjs scripts/project-processes.mjs /opt/swarmenv/
COPY --chown=0:0 scripts/swarm.mjs /opt/swarmenv/scripts/swarm.mjs
COPY --chown=0:0 src /opt/swarmenv/src
COPY --chown=0:0 services/opensandbox-agent/pi-models.json /opt/swarmenv/pi-agent/models.json
# Git archives may mark source directories group-writable. Protect all
# source files and the parent directories checked by the worker.
RUN chmod 0755 /opt/swarmenv \
  && chmod -R u=rwX,go=rX /opt/swarmenv/src \
  && chmod 0555 /opt/swarmenv/scripts/swarm.mjs \
  && ln -s /opt/swarmenv/scripts/swarm.mjs /usr/local/bin/swarm \
  && mkdir -p /workspace /opt/swarmenv/pi-agent

ENV PATH="/opt/swarmenv/node_modules/.bin:${PATH}" \
    PI_CODING_AGENT_DIR="/opt/swarmenv/pi-agent" \
    SWARMENV_PI_VERSION="${PI_VERSION}" \
    SWARMENV_AGENT_WORKER="/opt/swarmenv/agent-worker.mjs"

# The image contains the worker, native Pi package, direct Pi model catalog,
# shell tools and swarm CLI. Credentials are supplied only at runtime.
ENTRYPOINT ["node", "/opt/swarmenv/agent-worker.mjs"]
