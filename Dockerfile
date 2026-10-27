# syntax=docker/dockerfile:1
# The Wisp box server: agents and their automations running 24/7 on
# a small always-on machine. Build from app/:
#   docker build -t wisp-box .
#   docker build --build-arg CLAUDE_CODE=1 -t wisp-box .   # also installs Claude Code
# deploy/docker-compose.yml runs it behind Caddy for HTTPS.

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Only the bundler runs here: skip install scripts (Electron's binary download, native addons).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs --box-server --production

FROM node:24-bookworm-slim
ARG CLAUDE_CODE=0
# Claude Code keeps its sign-in under CLAUDE_CONFIG_DIR, on the data volume, so it survives image updates.
# Updates come with a rebuilt image, so Claude Code's own updater stays off.
ENV NODE_ENV=production \
    WISP_BOX_DATA_DIR=/data \
    WISP_BOX_HOST=0.0.0.0 \
    WISP_BOX_PORT=8787 \
    CLAUDE_CONFIG_DIR=/data/claude \
    DISABLE_AUTOUPDATER=1
RUN if [ "$CLAUDE_CODE" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ca-certificates git \
      && rm -rf /var/lib/apt/lists/* \
      && npm install -g @anthropic-ai/claude-code \
      && npm cache clean --force; \
    fi
WORKDIR /app
COPY --from=build /src/dist/box-server ./dist/box-server
COPY --from=build /src/dist/claude-bridge ./dist/claude-bridge
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const m=require(process.env.WISP_BOX_TLS_CERT?'https':'http');m.get({host:'127.0.0.1',port:process.env.WISP_BOX_PORT,path:'/livez',rejectUnauthorized:false},(r)=>process.exit(r.statusCode===204?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/box-server/main.cjs"]
