# Sequence Diagrams — Authentication & Authorization

## 1. Login → Refresh (Rotasi) → Reuse Detection

```mermaid
sequenceDiagram
    actor U as User
    participant API as API Server
    participant DB as PostgreSQL

    U->>API: POST /auth/login {email, password}
    API->>DB: cari User by email
    API->>API: bcrypt.compare(password, user.password)
    API->>DB: INSERT RefreshToken (familyId = uuid BARU)
    API-->>U: 200 {accessToken, refreshToken}

    Note over U,API: --- beberapa saat kemudian, accessToken kedaluwarsa ---

    U->>API: POST /auth/refresh {refreshToken}
    API->>DB: cari RefreshToken by tokenHash
    alt token valid & belum di-revoke
        API->>DB: UPDATE RefreshToken SET revokedAt = now() (yang lama)
        API->>DB: INSERT RefreshToken BARU (familyId SAMA, diteruskan)
        API-->>U: 200 {accessToken baru, refreshToken baru}
    else token SUDAH di-revoke sebelumnya (REUSE!)
        Note over API,DB: Sinyal token dicuri —<br/>seseorang memakai refresh token LAMA yang sudah dirotasi
        API->>DB: UPDATE RefreshToken SET revokedAt = now()<br/>WHERE familyId = family token ini (Phase 9)
        API-->>U: 401 Unauthorized — "silakan login ulang"
    end
```

**Kenapa hanya family yang dicabut, bukan seluruh sesi user** (Phase 9
upgrade) — lihat komentar lengkap di `prisma/schema.prisma` field
`RefreshToken.familyId`: reuse pada SATU device tidak boleh ikut
melogout device lain yang sah dan tidak terlibat.

## 2. Authorization (RBAC) — `requirePermission()`

```mermaid
sequenceDiagram
    actor U as User (role: ORGANIZER)
    participant MW1 as authMiddleware
    participant MW2 as requirePermission('event.delete')
    participant C as EventController

    U->>MW1: DELETE /events/:id (Bearer token)
    MW1->>MW1: verify JWT, decode {id, email, role}
    MW1->>MW1: req.user = {id, email, role}
    MW1->>MW2: next()
    MW2->>MW2: ROLE_PERMISSIONS[req.user.role]<br/>.includes('event.delete')?
    alt permission ADA di role user
        MW2->>C: next()
        C-->>U: 200 OK
    else permission TIDAK ADA
        MW2-->>U: 403 Forbidden
    end
```

`ROLE_PERMISSIONS` (kode, bukan tabel DB — lihat `docs/architecture.md`
untuk alasannya) didefinisikan di `shared/security/permissions.ts`.

## 3. Login Gagal → Account Lockout

```mermaid
sequenceDiagram
    actor U as User
    participant API as API Server
    participant Redis as Redis (login-attempt-tracker)

    U->>API: POST /auth/login (password salah)
    API->>Redis: incrementFailedAttempt(email)
    Redis-->>API: jumlah percobaan gagal saat ini
    alt di bawah batas maksimum
        API-->>U: 401 Unauthorized
    else mencapai batas maksimum
        API->>Redis: set lock TTL (unlock timer)
        API-->>U: 429 Too Many Requests — akun terkunci sementara
    end

    Note over U,API: --- setelah TTL lock habis ---
    U->>API: POST /auth/login (password benar)
    API->>Redis: checkAccountLock(email) -> tidak terkunci
    API->>Redis: resetAttempts(email)
    API-->>U: 200 OK
```

## 4. Session Revocation & Audit Trail (Phase 17)

```mermaid
sequenceDiagram
    actor U as User
    participant API as API Server
    participant DB as PostgreSQL

    U->>API: GET /auth/sessions
    API->>DB: SELECT RefreshToken WHERE userId=? AND revokedAt IS NULL
    API-->>U: 200 [{id, device, browser, ipAddress, isCurrent, lastActive}, ...]

    U->>API: DELETE /auth/sessions/:id (cabut SATU device)
    API->>DB: UPDATE RefreshToken SET revokedAt=now() WHERE id=?
    API->>DB: INSERT AuditLog (action=SESSION_REVOKED, entity=RefreshToken, entityId=sessionId)
    API-->>U: 200 Sesi berhasil dicabut

    Note over U,API: --- atau logout dari SEMUA device sekaligus ---
    U->>API: DELETE /auth/sessions (logout all)
    API->>DB: UPDATE RefreshToken SET revokedAt=now() WHERE userId=? AND revokedAt IS NULL
    API->>DB: INSERT AuditLog (action=SESSIONS_REVOKED_ALL, entity=User, entityId=userId)
    API-->>U: 200 Seluruh sesi berhasil dicabut
```

Catatan: `SESSION_REVOKED`/`SESSIONS_REVOKED_ALL` muncul di riwayat
yang sama dengan `GET /auth/login-history` (filter action-nya
diperluas mencakup keduanya) — satu sumber kebenaran untuk seluruh
riwayat keamanan akun, bukan endpoint terpisah.

## 5. Export Asynchronous via BullMQ (Phase 19)

```mermaid
sequenceDiagram
    actor U as User (Admin)
    participant API as API Server
    participant Q as Redis (BullMQ)
    participant W as Export Worker
    participant DB as PostgreSQL
    participant S as Object Storage

    U->>API: POST /exports {type: USERS, format: XLSX}
    API->>DB: INSERT ExportJob (status=QUEUED)
    API->>Q: exportQueue.add({exportJobId, type, format})
    API-->>U: 202 Accepted {id, status: QUEUED}

    Note over Q,W: --- worker mengambil job secara asinkron ---
    Q->>W: job export
    W->>DB: UPDATE ExportJob SET status=PROCESSING
    W->>DB: query data sesuai type (Users/AuditLog/DashboardStats)
    W->>W: generate file (toXlsxBuffer)
    W->>S: upload(key, buffer)
    S-->>W: {url}
    W->>DB: UPDATE ExportJob SET status=COMPLETED, fileUrl=url

    Note over U,API: --- client polling status ---
    U->>API: GET /exports/:id
    API->>DB: SELECT ExportJob WHERE id=? AND userId=?
    API-->>U: 200 {status: COMPLETED, fileUrl}
    U->>API: GET /exports/:id/download
    API-->>U: 302 Redirect -> fileUrl (object storage langsung, tidak lewat proses API)
```

Fallback (`REDIS_URL` tidak dikonfigurasi): langkah "worker mengambil
job secara asinkron" di atas TIDAK terjadi — `ExportService`
memproses `processExportJob` secara SINKRON di request `POST /exports`
yang sama (respons 202 tetap sama bentuknya, tapi database sudah
`COMPLETED` sebelum response dikirim). Lihat `export.service.ts`.
