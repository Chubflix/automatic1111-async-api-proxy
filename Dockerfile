## Multi-stage Dockerfile building TS -> JS and running from dist

FROM node:24-alpine AS builder
WORKDIR /app

# System deps for building native modules like better-sqlite3
RUN apk add --no-cache python3 make g++

# Install dependencies (including dev for build)
COPY package.json yarn.lock* ./
RUN yarn install

# Copy sources
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY schemas ./schemas

# Build to dist/
RUN yarn build


FROM node:24-alpine AS runtime
WORKDIR /app

# System deps for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install only production deps
COPY package.json yarn.lock* ./
RUN yarn install --production

# Copy built artifact and runtime assets
COPY migrations ./migrations
COPY --from=builder /app/dist/src ./src
COPY --from=builder /app/schemas ./schemas

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["yarn", "start"]
