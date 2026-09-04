# Multi-stage lightweight Dockerfile using Bun
FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# Install dependencies into temp folder
FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Release stage
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY src src
COPY package.json tsconfig.json .

# Set environment
ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

CMD ["bun", "src/index.ts"]
