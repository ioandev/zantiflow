# zantiflow plugin-dist (ADR-0021 conventions). Multi-stage, non-root, pinned base. Build CONTEXT is
# the repo root (it's a pnpm-workspace app), so build with:
#   docker build -f apps/plugin-dist/Dockerfile -t zantiflow/plugin-dist .
# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @zantiflow/plugin-dist... build
# Produce a self-contained production deployment of just this app.
RUN pnpm --filter=@zantiflow/plugin-dist --prod --legacy deploy /prod

FROM node:22-slim AS runtime
WORKDIR /app
RUN groupadd -r app && useradd -r -g app -d /app app
COPY --from=build --chown=app:app /prod /app
# Build identity (set at build time). Read at runtime for the startup log + /healthz. Declared in the
# runtime stage so a changing GIT_SHA never busts the layers above.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
USER app
ENV NODE_ENV=production PORT=4500 APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}
EXPOSE 4500
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://localhost:4500/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
