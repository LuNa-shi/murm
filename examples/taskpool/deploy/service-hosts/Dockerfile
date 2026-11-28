FROM node:22.19.0-bookworm-slim AS typescript-build
WORKDIR /build
COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY examples/taskpool ./examples/taskpool
RUN node node_modules/typescript/bin/tsc --project examples/taskpool/deploy/service-hosts/tsconfig.json \
  && rm -f dist/examples/taskpool/package.json

FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates git curl util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=typescript-build /build/dist ./dist
COPY examples/taskpool/services/judge/final-tree-proof.lean examples/taskpool/services/judge/lean-module-build.lean examples/taskpool/services/judge/lean-module-verify.lean ./dist/examples/taskpool/services/judge/
COPY examples/taskpool/services/judge/lean-module-verify.LICENSE.txt examples/taskpool/services/judge/lean-module-verify.NOTICE.md ./dist/examples/taskpool/services/judge/
COPY examples/taskpool/deploy/service-hosts/service-host-entrypoint.sh ./scripts/service-host-entrypoint.sh
COPY examples/taskpool/deploy/service-hosts/judge-peer-entrypoint.sh ./scripts/judge-peer-entrypoint.sh
RUN chmod 0555 ./scripts/service-host-entrypoint.sh ./scripts/judge-peer-entrypoint.sh

ENV MURM_SERVICE_HOST=0.0.0.0
ENV MURM_SERVICE_PORT=8787
ENV MURM_SERVICE_ID=task
ENV MURM_SERVICE_DATABASE=/var/lib/murm/service.sqlite
VOLUME ["/var/lib/murm"]
EXPOSE 8787
ENTRYPOINT ["./scripts/service-host-entrypoint.sh"]
