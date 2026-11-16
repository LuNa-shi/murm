FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git curl util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts/service-host.mjs ./scripts/service-host.mjs
COPY scripts/service-host-entrypoint.sh ./scripts/service-host-entrypoint.sh
COPY scripts/context-service-peer.mjs scripts/judge-service-peer.mjs ./scripts/
COPY services/builtin/judge-peer-entrypoint.sh ./scripts/judge-peer-entrypoint.sh
RUN chmod 0555 ./scripts/service-host-entrypoint.sh ./scripts/judge-peer-entrypoint.sh

ENV SWARMENV_SERVICE_HOST=0.0.0.0
ENV SWARMENV_SERVICE_PORT=8787
ENV SWARMENV_SERVICE_ID=task
ENV SWARMENV_SERVICE_DATABASE=/var/lib/swarmenv/service.sqlite
VOLUME ["/var/lib/swarmenv"]
EXPOSE 8787
ENTRYPOINT ["./scripts/service-host-entrypoint.sh"]
