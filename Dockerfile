# comical-host — the @comical/host-server REST API (published as ghcr.io/porksphere/comical-host).
#
# Self-contained: build context is this repo only. Ships the repo's own first-party sample bridges
# (example-bridge, direct-example, test-sprites) as a working default. Real sources are added at
# runtime — the running server's RegistryManager installs bridges/trackers from a user-supplied
# registry into {COMICAL_DATA_DIR}/bridge-cache. Nothing else is baked in.
FROM oven/bun:1

WORKDIR /app

# Dependencies first (cached until package files change). bun.lock is gitignored in this repo, so
# install non-frozen (same as .github/workflows/ci.yml) — there's no committed lock to honor.
COPY package.json ./
COPY packages/ packages/
COPY bridges/ bridges/
RUN bun install

# Build sample bridges → bridges/*/dist/bridge.js
COPY scripts/ scripts/
RUN bun run build

# The server imports packages as TS source; Bun runs them natively.
ENV PORT=3100
ENV COMICAL_DATA_DIR=/data
# Cross-origin web/app clients call this API from another origin, so allow any origin by default.
# Put a bearer token in front of it (COMICAL_TOKEN) if exposing beyond a trusted LAN.
ENV COMICAL_ORIGIN=*
EXPOSE 3100
VOLUME ["/data"]

CMD ["bun", "run", "packages/host-server/src/server.ts"]
