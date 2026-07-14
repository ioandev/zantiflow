# zantiflow docs site (ADR-0023 → ADR-0048). Starlight (Astro) static build → non-root nginx, served
# at docs.<domain> behind Caddy. Build CONTEXT is the repo root:
#   docker build -f docs/Dockerfile -t zantiflow/docs .
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Build identity (parity with the other images; declared after `install` so a changing GIT_SHA doesn't
# bust the dependency layer). Astro inlines these only if referenced as PUBLIC_* — kept for provenance.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}
RUN pnpm --filter @zantiflow/docs build

# nginx-unprivileged runs as non-root (uid 101) and listens on 8080 — matches ADR-0021's non-root,
# no-privileged-port posture. Pinned (no :latest, audit I8); multi-arch (amd64 + arm64).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# Third-party license compliance (ADR-0036): ship our LICENSE/NOTICE inside the image (not web-served).
COPY LICENSE NOTICE /
COPY docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/docs/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:8080/ || exit 1
