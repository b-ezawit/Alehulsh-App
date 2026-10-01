# Portable by design — nothing here knows where it runs.
# Cloud Run now if needed; the in-country host after C-04. See docs/api-layer.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --project tsconfig.json --skipLibCheck

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Keyword verification is scrypt at N=2^16 — ~160ms and a ~64MB working set per
# call. crypto.scrypt runs on the libuv threadpool, which defaults to FOUR
# threads regardless of how many cores the host has, so a 16-core box was
# capped at ~20 verifications/sec with 12 cores idle. Sizing the pool to the
# cores took that to ~32/sec. Measured, not assumed.
#
# It does not scale linearly past that because scrypt at this cost is
# memory-bandwidth-bound rather than CPU-bound — which is also why switching
# language would not fix it. Set this from the host's core count at deploy.
ENV UV_THREADPOOL_SIZE=16
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Never run as root.
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
