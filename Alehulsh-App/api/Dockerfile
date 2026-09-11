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
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Never run as root.
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
