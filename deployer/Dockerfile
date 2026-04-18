FROM docker:27-cli

# docker-compose-plugin ships with docker-cli on alpine starting 24.x; add
# the rest of the tools the deploy script needs.
RUN apk add --no-cache \
      bash \
      git \
      curl \
      jq \
      sqlite \
      coreutils

COPY deploy.sh /usr/local/bin/deploy.sh
RUN chmod +x /usr/local/bin/deploy.sh

ENTRYPOINT ["/usr/local/bin/deploy.sh"]
