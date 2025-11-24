# Multi-stage Dockerfile for automatic-async-proxy (Express + Swagger UI)

FROM node:24-alpine AS base
WORKDIR /app

# System deps for building native modules like better-sqlite3
RUN apk add --no-cache python3 make g++

# Install dependencies first
COPY package.json ./
RUN yarn install --production

# Copy application sources
COPY src ./src
COPY schemas ./schemas

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["yarn", "start"]
