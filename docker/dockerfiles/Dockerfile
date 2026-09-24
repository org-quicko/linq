# syntax=docker/dockerfile:1

ARG LINQ_CLIENT_BASE_PATH=/

# The API, the redirects and the Client UI (served at LINQ_CLIENT_BASE_PATH)
# from one process. Published as linq, the only published image, with the
# default /: the UI answers only on LINQ_APP_HOST, which must then be set at
# runtime (docs/adr/0019).
#
# Build from the repo root, not this directory:
#   docker build -f docker/dockerfiles/Dockerfile -t linq .
# UI under a path on every host instead (requires a rebuild; the Compose
# examples pass /home):
#   docker build --build-arg LINQ_CLIENT_BASE_PATH=/home -f docker/dockerfiles/Dockerfile -t linq .
#
# Stage 1 builds the Client UI into a static export. Nothing from here ships
# except apps/client/out.
FROM oven/bun:1.4 AS build
ARG LINQ_CLIENT_BASE_PATH
WORKDIR /app

ENV NEXT_PUBLIC_BASE_PATH=${LINQ_CLIENT_BASE_PATH}

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

COPY packages/shared/src packages/shared/src
COPY apps/client apps/client
RUN bun --filter '@linq/client' build

# Stage 2 is the runtime: Bun executes the server sources directly, so there is
# no server bundle step. Postgres is always external; see docker/examples/docker-compose/.
FROM oven/bun:1.4 AS runtime
ARG LINQ_CLIENT_BASE_PATH
WORKDIR /app

ENV NODE_ENV=production
ENV LINQ_DATA_DIR=/data
ENV LINQ_PORT=3000
ENV LINQ_CLIENT_BASE_PATH=${LINQ_CLIENT_BASE_PATH}
ENV LINQ_CACHE_SWEEP_INTERVAL=60
# Logs go to stdout and to /data/logs/linq.log, rotated and capped.
ENV LINQ_LOG_LEVEL=info

COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
# The admin package.json is present only to keep the lockfile whole; --filter
# keeps next and react out of the runtime image.
RUN bun install --frozen-lockfile --production --filter '@linq/server' --filter '@linq/shared'

COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/client/out apps/client/out

EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
