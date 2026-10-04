FROM node:22-alpine

WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# tsx runs the TypeScript directly; there is no build artefact to go stale.
RUN npm install tsx@^4.19.2

COPY tsconfig.json server.ts ./
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY public ./public
COPY loadtest ./loadtest

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
