FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.server.json tsconfig.client.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY client ./client
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8048 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/show-login.mjs ./scripts/show-login.mjs
RUN mkdir /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
EXPOSE 8048
CMD ["node", "dist/server/index.js"]
