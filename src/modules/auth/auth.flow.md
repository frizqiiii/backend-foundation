# Authentication Flow (implementasi nyata)

## Register
```
POST /api/auth/register
  -> registerSchema.parse (Zod)
  -> AuthService.register
       -> UserRepository.findByEmail (cek duplikat)
       -> bcrypt.hash
       -> UserRepository.create
```

## Login
```
POST /api/auth/login
  -> loginSchema.parse
  -> AuthService.login
       -> UserRepository.findByEmail
       -> bcrypt.compare
       -> jwtHelper.sign            (access token)
       -> generateRefreshToken + hashRefreshToken + AuthRepository.createRefreshToken
```

## Refresh (dengan rotasi + deteksi reuse)
```
POST /api/auth/refresh
  -> AuthService.refresh
       -> hash token masuk, cari di AuthRepository
       -> jika revoked  -> revoke SEMUA token user ini, tolak
       -> jika expired  -> tolak
       -> revoke token lama, terbitkan access+refresh token baru
```

## Protected route
```
Request -> authMiddleware (verify JWT, isi req.user)
        -> requireRole(...) [opsional, untuk RBAC]
        -> Controller
```
