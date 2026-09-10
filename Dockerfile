# syntax=docker/dockerfile:1

# ============================================================================
# STAGE 0: base — image dasar bersama, dipakai ulang oleh stage lain
# ============================================================================
FROM node:20-alpine AS base
WORKDIR /app
# openssl & libc6-compat dibutuhkan oleh Prisma query engine di Alpine (musl).
RUN apk add --no-cache openssl libc6-compat

# ============================================================================
# STAGE 1: deps — install SELURUH dependency (termasuk devDependencies),
# dipakai untuk proses build & type-checking.
# ============================================================================
FROM base AS deps
COPY package.json package-lock.json ./
# python3/make/g++ dibutuhkan node-gyp untuk kompilasi native addon (bcrypt).
# Dihapus lagi setelah instalasi agar layer ini tetap seminimal mungkin.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci \
  && apk del .build-deps

# ============================================================================
# STAGE 2: builder — compile TypeScript → JavaScript & generate Prisma Client.
# ============================================================================
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# WAJIB dijalankan sebelum `npm run build`: tipe hasil `prisma generate`
# (mis. model `User`, `Product`) dipakai langsung oleh source TypeScript,
# jadi compile akan gagal jika Prisma Client belum digenerate lebih dulu.
RUN npx prisma generate
RUN npm run build

# ============================================================================
# STAGE 3: prod-deps — install HANYA production dependency (tanpa TypeScript,
# ts-node-dev, eslint, jest, dsb) untuk meminimalkan ukuran image akhir.
# ============================================================================
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --omit=dev \
  && apk del .build-deps

# ============================================================================
# STAGE 4: runner — image final yang benar-benar dijalankan di production.
# Hanya membawa: node_modules production, hasil compile (dist), Prisma Client
# hasil generate, dan schema Prisma. Tidak ada source TypeScript maupun
# devDependencies sama sekali.
# ============================================================================
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat

ENV NODE_ENV=production

# Jalankan sebagai non-root user — praktik keamanan dasar container.
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

COPY --from=prod-deps /app/node_modules ./node_modules
# Prisma Client hasil generate (engine binary + kode) tersimpan di
# node_modules/.prisma — overlay dari builder stage, karena `prod-deps`
# tidak pernah menjalankan `prisma generate`.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

USER nodejs

EXPOSE 3000

# HEALTHCHECK native Docker — dibaca langsung oleh `docker ps` (kolom
# STATUS), Docker Swarm, ECS, dan platform lain yang memahami
# instruksi Dockerfile ini tanpa perlu konfigurasi tambahan di luar
# image (beda dari healthcheck di docker-compose.yml yang HANYA
# berlaku saat dijalankan lewat Compose). Memakai `wget` bawaan
# BusyBox di Alpine — tidak perlu `apk add curl` yang akan menambah
# ukuran image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
