# --- build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# --- runtime stage ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# create an `app` user matching the host UID/GID so bind-mounts end up owned
# by the host user. The base image ships `node` on UID 1000; drop it first.
ARG PUID=1000
ARG PGID=1000
RUN if id node >/dev/null 2>&1; then userdel -r node 2>/dev/null || true; fi \
    && if getent group node >/dev/null 2>&1; then groupdel node 2>/dev/null || true; fi \
    && groupadd -g "$PGID" app \
    && useradd -m -u "$PUID" -g "$PGID" -s /bin/bash app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
RUN chown -R app:app /app
ENV HOME=/home/app
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
