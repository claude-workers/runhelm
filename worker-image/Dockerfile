FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git tini gnupg lsb-release gosu \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
         | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
         https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
         > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# global install of claude-code CLI (provides `claude login` / `claude`)
RUN npm install -g @anthropic-ai/claude-code@latest

# create worker user. UID/GID are configurable so host bind-mounts end up
# owned by the host user. The base image ships a `node` user on UID 1000;
# drop it so we can reuse that UID when PUID=1000.
ARG PUID=1000
ARG PGID=1000
RUN if id node >/dev/null 2>&1; then userdel -r node 2>/dev/null || true; fi \
    && if getent group node >/dev/null 2>&1; then groupdel node 2>/dev/null || true; fi \
    && groupadd -g "$PGID" worker \
    && useradd -m -u "$PUID" -g "$PGID" -s /bin/bash worker \
    && mkdir -p /home/worker/.claude \
    && chown -R worker:worker /home/worker

WORKDIR /opt/supervisor
COPY package.json ./
RUN npm install

COPY supervisor.ts ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && chown -R worker:worker /opt/supervisor

ENV HOME=/home/worker \
    CLAUDE_CONFIG_DIR=/home/worker/.claude

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
