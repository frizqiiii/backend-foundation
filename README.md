# Backend Foundation — Modular Monolith (Node.js + TypeScript + Express + Prisma)

Template fondasi backend dengan arsitektur **Modular Monolith** dan pola
**Layered Architecture (Controller → Service → Repository)**, disusun
berbasis fitur/domain (feature-based structure).

## Struktur Folder

```
backend-foundation/
├── prisma/
│   └── schema.prisma          # Skema database (single source of truth)
├── src/
│   ├── modules/                # Setiap domain bisnis = 1 folder mandiri
│   │   └── users/
│   │       ├── user.controller.ts   # HTTP layer (request/response)
│   │       ├── user.service.ts      # Business logic layer
│   │       ├── user.repository.ts   # Data access layer (Prisma queries)
│   │       ├── user.dto.ts          # Data Transfer Objects & validasi schema
│   │       ├── user.routes.ts       # Route binding untuk modul ini
│   │       └── user.errors.ts       # Domain-specific errors
│   ├── shared/
│   │   ├── config/
│   │   │   ├── env.ts               # Validasi environment variable (fail-fast)
│   │   │   └── database.ts          # Prisma Client singleton
│   │   ├── middlewares/
│   │   │   ├── error-handler.ts     # Global error handler
│   │   │   └── async-handler.ts     # Wrapper untuk async controller
│   │   └── utils/
│   │       └── http-error.ts        # Custom HTTP error class
│   ├── app.ts                  # Express app assembly (middlewares + routes)
│   └── server.ts               # Entry point (bootstrap & listen)
├── .env.example
├── package.json
└── tsconfig.json
```

## Prinsip Desain

1. **Feature-based, bukan layer-based di root.** Setiap modul (`users`,
   `orders`, dst.) berdiri sendiri dan berisi seluruh layer-nya. Ini
   membuat modul mudah dipahami, dipisah jadi microservice di masa
   depan, atau dihapus tanpa menyentuh modul lain.
2. **Separation of Concerns ketat:**
   - **Controller** — HANYA menangani HTTP (parsing request, memanggil
     service, membentuk response). Tidak ada query database atau logic
     bisnis di sini.
   - **Service** — HANYA business logic (validasi bisnis, orchestrasi,
     hashing, dsb). Tidak tahu soal `req`/`res`, tidak memanggil Prisma
     langsung.
   - **Repository** — HANYA akses data (Prisma). Tidak ada logic bisnis.
3. **Dependency Injection manual (constructor injection)** — setiap
   layer menerima dependensinya lewat constructor, bukan `import`
   langsung ke instance global. Ini membuat setiap layer mudah di-unit
   test dengan mock.
4. **Fail-fast configuration** — aplikasi menolak start jika environment
   variable wajib tidak lengkap/salah format, dicek oleh `envalid`
   sebelum server listen.
5. **Prisma Client sebagai singleton** — mencegah exhaust connection
   pool akibat instansiasi berulang, terutama saat hot-reload di
   development.

## Menambah Modul Baru

Duplikasi folder `src/modules/users`, ganti nama entity dan sesuaikan
skema Prisma. Daftarkan route barunya di `src/app.ts`. Pola Controller →
Service → Repository tetap sama di seluruh modul agar konsisten menjadi
"kiblat" tim.

## Docker

Dua file compose dengan tujuan berbeda:

- **`docker-compose.yml`** — development lokal, hot-reload aktif.
  ```bash
  docker compose up --build
  # aplikasi: http://localhost:3000
  # Postgres juga bisa diakses langsung: localhost:5432
  ```

- **`docker-compose.prod.yml`** — simulasi/deployment production:
  image final yang ringan (`Dockerfile` stage `runner`, tanpa
  devDependencies), tanpa bind mount source code, port PostgreSQL
  TIDAK dipublish ke host.
  ```bash
  # 1. Jalankan migrasi SEKALI (service terpisah, tidak auto-start)
  docker compose -f docker-compose.prod.yml run --rm migrate

  # 2. Baru jalankan aplikasi
  docker compose -f docker-compose.prod.yml up --build -d

  # Cek status healthcheck
  docker compose -f docker-compose.prod.yml ps
  ```

  `DB_PASSWORD` wajib di-set di `.env` — compose ini akan menolak start
  tanpa itu (`${DB_PASSWORD:?...}`), mencegah deployment production
  dengan password default yang lupa diganti.

## Deployment ke VPS (bare-metal, bukan Docker)

Untuk deploy langsung ke Ubuntu VPS (Nginx + PM2 + SSL Let's Encrypt +
strategi backup database), lihat runbook lengkap di
[`deploy/README.md`](./deploy/README.md).
