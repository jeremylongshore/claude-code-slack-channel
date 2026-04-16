FROM oven/bun:1-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY server.ts ./

# State dir is mounted at runtime: -v ~/.claude/channels/slack:/state
ENV SLACK_STATE_DIR=/state

ENTRYPOINT ["bun", "server.ts"]
