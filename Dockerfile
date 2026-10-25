# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# prisma's query engine needs openssl
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# npm install instead of npm ci: the lockfile is generated on windows and npm resolves
# a few optional packages differently on linux, which makes npm ci refuse it
RUN npm install --no-audit --no-fund

COPY . .
RUN npx prisma generate && npm run build

# ---- run ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# dev dependencies are kept on purpose: prisma cli (migrations) and ts-node (seed) run at startup
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json tsconfig.json ./
COPY prisma ./prisma
COPY public ./public

EXPOSE 3000

# apply migrations, add demo data if the db is empty, then start
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && node dist/main"]
