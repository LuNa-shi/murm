FROM node:22.19.0-bookworm-slim AS typescript-build
WORKDIR /build
COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
COPY benchmarks/fate ./benchmarks/fate
COPY benchmarks/lead-worker-orders ./benchmarks/lead-worker-orders
COPY test-support/subagents/communication-fixture-prompts.ts ./test-support/subagents/
COPY deploy ./deploy
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=typescript-build /build/dist ./dist

ENV MATHLIB_SEARCH_HOST=0.0.0.0
ENV MATHLIB_SEARCH_PORT=8787
EXPOSE 8787
CMD ["node", "dist/examples/services/mathlib-search/main.js"]
