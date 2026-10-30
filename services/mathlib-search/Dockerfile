FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts/mathlib-search-service.mjs ./scripts/mathlib-search-service.mjs

ENV MATHLIB_SEARCH_HOST=0.0.0.0
ENV MATHLIB_SEARCH_PORT=8787
EXPOSE 8787
CMD ["node", "scripts/mathlib-search-service.mjs"]
