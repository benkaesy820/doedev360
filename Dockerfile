# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps (including devDeps needed for tsc)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY . .
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output + config.json (build script copies it to dist/)
COPY --from=builder /app/dist ./dist

EXPOSE 7860

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860

CMD ["node", "dist/src/index.js"]
