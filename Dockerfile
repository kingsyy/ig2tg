# ── build stage ──────────────────────────────────────────
FROM node:22-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci

COPY tsconfig.json ./
COPY source/ source/
RUN npm run build

# ── runtime stage ────────────────────────────────────────
FROM node:22-alpine

# ffmpeg for voice conversion (TG OGG Opus → IG AAC)
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Keep the Instagram session, internal config, logs, and SQLite database together
# on the persistent /app/data volume. Without this, Docker recreations lose login state.
ENV HOME=/app/data

COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY config.yaml ./

RUN mkdir -p /app/data

VOLUME ["/app/data"]

CMD ["node", "dist/bridge/index.js"]
