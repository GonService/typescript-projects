# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# No runtime dependencies: the final image only carries the compiled JavaScript.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
WORKDIR /work
RUN chown node:node /work
USER node
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["--help"]
