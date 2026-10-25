# Veil Mailbox Relay - hardened, dependency-free container.
# Base image pinned by digest (Dependabot keeps it current).
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

ENV NODE_ENV=production \
    PORT=8787 \
    VEIL_RELAY_DATA=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "src/main.ts"]
