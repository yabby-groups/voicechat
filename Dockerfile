FROM node:22-bookworm-slim AS build

# onnxruntime-node ships a glibc binary and uses OpenMP on Linux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# VoiceChat uses the bundled CPU binding. Skip ONNX Runtime's optional CUDA
# provider download, whose NuGet endpoint redirects during image builds.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci

COPY . .

# Vite exposes these public values to the browser at build time.
ARG VITE_MYNA_BASE_URL
ARG VITE_MYNA_OAUTH_CLIENT_ID
ENV VITE_MYNA_BASE_URL=$VITE_MYNA_BASE_URL \
    VITE_MYNA_OAUTH_CLIENT_ID=$VITE_MYNA_OAUTH_CLIENT_ID

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
