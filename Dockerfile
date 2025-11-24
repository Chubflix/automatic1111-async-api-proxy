# Multi-stage Dockerfile for automatic-async-proxy (Express + Swagger UI)

FROM node:18-alpine AS base
WORKDIR /app

# Install dependencies first
COPY package.json ./
RUN yarn install --production 

# Copy application sources
COPY src ./src
COPY schemas ./schemas

ENV NODE_ENV=production

CMD ["yarn", "start"]
