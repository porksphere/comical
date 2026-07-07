# comical-host — the @comical/host-server REST API (published as ghcr.io/porksphere/comical-host).
#
# Self-contained: build context is this repo only. The published image bundles NO bridges — real
# sources are added at runtime, where the server's RegistryManager installs bridges/trackers from a
# user-supplied registry into {COMICAL_DATA_DIR}/bridge-cache.
#
# Targets:
#   prod (default) — no bundled bridges. This is what CI publishes.
#   dev            — also bundles + builds this repo's example bridges, for a self-contained local
#                    image: `docker build --target dev -t comical-host:dev .`

FROM oven/bun:1 AS base
WORKDIR /app
# Dependencies first (cached until package files change). bun.lock is gitignored in this repo, so
# install non-frozen (same as .github/workflows/ci.yml) — there's no committed lock to honor.
COPY package.json ./
COPY packages/ packages/
RUN bun install
# The server imports packages as TS source; Bun runs them natively. A missing bridges dir is fine —
# discoverBridges() tolerates it (registry-installed bridges live under /data/bridge-cache instead).
ENV PORT=3100
ENV COMICAL_DATA_DIR=/data
# Cross-origin web/app clients call this API from another origin, so allow any origin by default.
# Put a bearer token in front of it (COMICAL_TOKEN) if exposing beyond a trusted LAN.
ENV COMICAL_ORIGIN=*
EXPOSE 3100
VOLUME ["/data"]
CMD ["bun", "run", "packages/host-server/src/server.ts"]

# ── dev: bundle the repo's example bridges (local convenience, never published) ───────────────────
FROM base AS dev
COPY bridges/ bridges/
COPY scripts/ scripts/
# Re-install so the newly-copied bridges/* workspaces resolve @comical/sdk, then build them.
RUN bun install && bun run build

# ── prod (default, published): no bundled bridges ─────────────────────────────────────────────────
FROM base AS prod
