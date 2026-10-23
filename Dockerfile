# Immagine multi-architettura: funziona su Raspberry Pi (arm64 e armv7) e su x86_64.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8765

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

USER node
EXPOSE 8765

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
