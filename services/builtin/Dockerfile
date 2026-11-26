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

FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git curl util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=typescript-build /build/dist ./dist
COPY scripts/service-host-entrypoint.sh ./scripts/service-host-entrypoint.sh
COPY services/builtin/judge-peer-entrypoint.sh ./scripts/judge-peer-entrypoint.sh
RUN chmod 0555 ./scripts/service-host-entrypoint.sh ./scripts/judge-peer-entrypoint.sh

ENV MURM_SERVICE_HOST=0.0.0.0
ENV MURM_SERVICE_PORT=8787
ENV MURM_SERVICE_ID=task
ENV MURM_SERVICE_DATABASE=/var/lib/murm/service.sqlite
VOLUME ["/var/lib/murm"]
EXPOSE 8787
ENTRYPOINT ["./scripts/service-host-entrypoint.sh"]
