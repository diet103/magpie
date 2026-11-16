# syntax=docker/dockerfile:1
# Node 26 runs the TypeScript sources directly (type stripping), so there is no build step.
# Pin by digest once deployed (docker buildx imagetools inspect node:26-trixie-slim).

FROM node:26-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 ca-certificates tini util-linux \
 && rm -rf /var/lib/apt/lists/*
# Litestream 0.5.x, statically linked, from the official image.
COPY --from=litestream/litestream:0.5.17 /usr/local/bin/litestream /usr/local/bin/litestream
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /entrypoint.sh
# Strip Windows line endings in case the file was checked out with CRLF, which would stop the container from starting.
RUN sed -i 's/\r$//' /entrypoint.sh /etc/litestream.yml && chmod 0755 /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
