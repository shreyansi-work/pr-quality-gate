# ---- build stage: install everything, generate the Prisma client, compile ----
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
# generate only needs the schema; the URL below is a placeholder that is never connected to
RUN DATABASE_URL=postgres://build:build@localhost:5432/build npx prisma generate
RUN npm run build

# ---- run stage ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma7.config.ts ./
COPY --from=build /app/public ./public
EXPOSE 3000
# apply pending migrations, then start. `migrate deploy` never creates or resets anything by itself.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
