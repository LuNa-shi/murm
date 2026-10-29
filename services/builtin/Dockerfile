FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts/service-host.mjs ./scripts/service-host.mjs

ENV SWARMENV_SERVICE_HOST=0.0.0.0
ENV SWARMENV_SERVICE_PORT=8787
ENV SWARMENV_SERVICE_ID=task
ENV SWARMENV_SERVICE_DATABASE=/var/lib/swarmenv/service.sqlite
VOLUME ["/var/lib/swarmenv"]
EXPOSE 8787
CMD ["node", "scripts/service-host.mjs"]
