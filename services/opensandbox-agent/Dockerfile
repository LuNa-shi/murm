# syntax=docker/dockerfile:1.7

FROM node:22.19.0-bookworm-slim

ARG PI_VERSION=1.3.0
LABEL org.swarmenv.opensandbox.pi-version="${PI_VERSION}" \
      org.swarmenv.opensandbox.provider="gpt_proxy"

RUN apt-get update \
  && apt-get install --no-install-recommends --yes bash ca-certificates git util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/swarmenv
COPY package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY scripts/opensandbox-agent-worker.mjs /opt/swarmenv/agent-worker.mjs
COPY scripts/sandbox-project.mjs /opt/swarmenv/sandbox-project.mjs
COPY scripts/swarm.mjs /opt/swarmenv/scripts/swarm.mjs
COPY src /opt/swarmenv/src
COPY services/opensandbox-agent/pi-models.json /opt/swarmenv/pi-agent/models.json
RUN chmod 0555 /opt/swarmenv/scripts/swarm.mjs \
  && ln -s /opt/swarmenv/scripts/swarm.mjs /usr/local/bin/swarm \
  && mkdir -p /workspace /opt/swarmenv/pi-agent

ENV PATH="/opt/swarmenv/node_modules/.bin:${PATH}" \
    PI_CODING_AGENT_DIR="/opt/swarmenv/pi-agent" \
    SWARMENV_PI_VERSION="${PI_VERSION}" \
    SWARMENV_AGENT_WORKER="/opt/swarmenv/agent-worker.mjs"

# The image contains the worker, native Pi package, direct Pi model catalog,
# shell tools and swarm CLI. Credentials are supplied only at runtime.
ENTRYPOINT ["node", "/opt/swarmenv/agent-worker.mjs"]
