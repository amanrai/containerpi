FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git openssh-client ca-certificates curl \
    ripgrep fd-find python3 python3-pip \
    tini gosu sudo tmux procps less nano vim \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @mariozechner/pi-coding-agent

COPY entrypoint.mjs /usr/local/bin/container-pi-entrypoint.mjs
RUN chmod +x /usr/local/bin/container-pi-entrypoint.mjs

WORKDIR /workspace
ENTRYPOINT ["tini", "--", "node", "/usr/local/bin/container-pi-entrypoint.mjs"]
CMD ["pi"]
