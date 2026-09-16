# syntax=docker/dockerfile:1

# Stage 1 builds the Admin UI into a static export. Nothing from here ships
# except apps/client/out.
FROM oven/bun:1.4 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

COPY packages/shared/src packages/shared/src
COPY apps/client apps/client
RUN bun --filter '@linq/admin' build

# Stage 2 is the runtime: Bun executes the server sources directly, so there is
# no server bundle step. Postgres is always external; see docker-compose.example.yml.
FROM oven/bun:1.4 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV LINQ_DATA_DIR=/data
# The geolocation database is a regenerable cache, so it gets its own volume and
# leaves /data holding only what is worth backing up. See docs/adr/0005.
ENV LINQ_GEO_DIR=/geo
ENV LINQ_PORT=3000
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
COPY apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/client/out apps/client/out

VOLUME /data
VOLUME /geo
EXPOSE 3000
CMD ["bun", "apps/server/src/main.ts"]
