FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true CHROMIUM_PATH=/usr/bin/chromium CASHWATCH_NO_SANDBOX=1 TZ=Asia/Jerusalem NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev
ENV CASHWATCH_DATA=/data
VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/cli.js", "serve"]
