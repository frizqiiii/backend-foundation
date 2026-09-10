import { errorResponse, validationErrorResponse, serverErrorResponse } from './openapi.shared';

const nullDataProps = { data: { type: 'object', nullable: true, example: null } };

export const authPaths = {
  '/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Registrasi user baru',
      description:
        'Role selalu default USER — tidak bisa diset lewat endpoint ini. Akun dibuat dengan ' +
        'email BELUM terverifikasi; token verifikasi diterbitkan dan "dikirim" (lihat ' +
        'POST /auth/verify-email). Login akan ditolak (403) sampai email diverifikasi.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'email', 'password'],
              properties: {
                name: { type: 'string', minLength: 2, example: 'Budi Santoso' },
                email: { type: 'string', format: 'email', example: 'budi@example.com' },
                password: { type: 'string', minLength: 8, example: 'Password123' },
              },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'Registrasi berhasil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example: 'Registrasi berhasil. Cek email untuk verifikasi akun.',
                  },
                  data: { $ref: '#/components/schemas/UserResponse' },
                },
              },
            },
          },
        },
        '409': errorResponse('Email sudah terdaftar', 'Email sudah terdaftar'),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login — menerbitkan access token + refresh token',
      description:
        'Ditolak (403) jika email belum diverifikasi. Jika user mengaktifkan MFA, response ' +
        '200 TIDAK berisi token — melainkan `{mfaRequired: true, challengeToken}`; client harus ' +
        'melanjutkan ke POST /auth/mfa/verify-login dengan challengeToken tersebut untuk benar-' +
        'benar menyelesaikan login.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string', format: 'email', example: 'budi@example.com' },
                password: { type: 'string', example: 'Password123' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Login berhasil (jika MFA tidak aktif), ATAU kredensial benar tapi MFA masih perlu ' +
            'diverifikasi (lihat POST /auth/mfa/verify-login)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Login berhasil' },
                  data: {
                    oneOf: [
                      { $ref: '#/components/schemas/AuthResponse' },
                      {
                        type: 'object',
                        description: 'Dikembalikan jika user.mfaEnabled === true',
                        properties: {
                          mfaRequired: { type: 'boolean', example: true },
                          challengeToken: { type: 'string' },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Email tidak ditemukan ATAU password salah (pesan sengaja disamakan — mencegah user enumeration)',
          'Email atau password salah'
        ),
        '403': errorResponse(
          'Email belum diverifikasi',
          'Email belum diverifikasi. Silakan cek email Anda.'
        ),
        '422': validationErrorResponse,
        '429': errorResponse(
          'Akun terkunci sementara akibat terlalu banyak percobaan login gagal beruntun',
          'Terlalu banyak percobaan login gagal. Coba lagi dalam 15 menit.'
        ),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/mfa/verify-login': {
    post: {
      tags: ['Auth'],
      summary: 'Langkah kedua login untuk user dengan MFA aktif',
      description:
        'Dipanggil setelah POST /auth/login mengembalikan `{mfaRequired: true, challengeToken}` ' +
        '(kredensial password sudah benar, tapi login belum selesai). `code` menerima kode TOTP ' +
        '6 digit MAUPUN recovery code (format `XXXXX-XXXXX`) — satu field untuk keduanya. ' +
        'Endpoint ini PUBLIK (tidak butuh access token) — otorisasinya adalah kepemilikan ' +
        '`challengeToken` yang valid, sama pola dengan POST /auth/refresh. Punya rate-limit ' +
        'per-akun terpisah dari /auth/login (identifier `mfa:<userId>`) di luar rate-limit per-IP.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['challengeToken', 'code'],
              properties: {
                challengeToken: { type: 'string' },
                code: { type: 'string', example: '123456' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Login berhasil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Login berhasil' },
                  data: { $ref: '#/components/schemas/AuthResponse' },
                },
              },
            },
          },
        },
        '401': errorResponse(
          'challengeToken tidak valid/kedaluwarsa, atau kode TOTP/recovery salah',
          'Kode MFA tidak valid'
        ),
        '422': validationErrorResponse,
        '429': errorResponse(
          'Terlalu banyak percobaan kode MFA gagal beruntun untuk akun ini',
          'Terlalu banyak percobaan kode MFA gagal. Coba lagi dalam 15 menit.'
        ),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Tukar refresh token dengan pasangan token baru (rotasi)',
      description:
        'Refresh token LAMA langsung tidak berlaku setelah dipakai. Jika refresh token yang sudah ' +
        'tidak berlaku dipakai lagi (indikasi pencurian token), SELURUH sesi aktif user tersebut ikut dicabut.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              properties: { refreshToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Token berhasil diperbarui',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Token berhasil diperbarui' },
                  data: { $ref: '#/components/schemas/AuthTokenPair' },
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Refresh token tidak valid, sudah kedaluwarsa, atau sudah pernah dipakai (di-revoke)',
          'Refresh token tidak valid'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/logout': {
    post: {
      tags: ['Auth'],
      summary:
        'Logout — mencabut satu sesi (refresh token) DAN memblacklist access token yang sedang dipakai',
      description:
        'Access token yang dipakai untuk memanggil endpoint ini langsung tidak berlaku lagi ' +
        'sejak saat itu juga (dicatat di tabel blacklist via `jti`), tidak menunggu sampai ' +
        'kedaluwarsa alami.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              properties: { refreshToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Logout berhasil (juga sukses secara idempotent jika refresh token sudah tidak valid)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Logout berhasil' },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Access token tidak ada/tidak valid/kedaluwarsa/sudah di-blacklist',
          'Token sudah kadaluarsa'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/verify-email': {
    post: {
      tags: ['Auth'],
      summary: 'Verifikasi email memakai token yang dikirim saat registrasi',
      description: 'Token single-use — tidak bisa dipakai dua kali, berlaku 24 jam.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Email berhasil diverifikasi',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Email berhasil diverifikasi' },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Token tidak valid atau sudah kedaluwarsa',
          'Token verifikasi tidak valid atau sudah kedaluwarsa'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/forgot-password': {
    post: {
      tags: ['Auth'],
      summary: 'Minta link/token reset password',
      description:
        'SELALU 200 terlepas dari apakah email terdaftar atau tidak — mencegah user ' +
        'enumeration. Token (berlaku 1 jam) "dikirim" lewat email jika akun memang ada.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string', format: 'email' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description:
            'Instruksi reset password terkirim (atau diam-diam diabaikan jika email tidak terdaftar)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example: 'Jika email terdaftar, instruksi reset password telah dikirim',
                  },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/reset-password': {
    post: {
      tags: ['Auth'],
      summary: 'Reset password memakai token dari forgot-password',
      description:
        'Berhasil reset akan mencabut SELURUH sesi (refresh token) aktif user tersebut — ' +
        'memaksa re-login di semua device, mengantisipasi kemungkinan password lama sudah bocor.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'newPassword'],
              properties: {
                token: { type: 'string' },
                newPassword: { type: 'string', minLength: 8 },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Password berhasil direset',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example: 'Password berhasil direset. Silakan login ulang.',
                  },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Token tidak valid atau sudah kedaluwarsa',
          'Token reset password tidak valid atau sudah kedaluwarsa'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/oauth/google': {
    post: {
      tags: ['Auth'],
      summary: 'Login/registrasi via Google',
      description:
        '`idToken` berasal dari Google Identity Services di sisi frontend. Jika email belum ' +
        'pernah terdaftar, akun baru dibuat otomatis TANPA password (emailVerifiedAt langsung ' +
        'terisi — Google sudah membuktikan kepemilikan email).',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['idToken'],
              properties: { idToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Login berhasil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Login Google berhasil' },
                  data: { $ref: '#/components/schemas/AuthResponse' },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'GOOGLE_CLIENT_ID belum dikonfigurasi di server',
          'Login Google belum dikonfigurasi di server ini.'
        ),
        '401': errorResponse('idToken tidak valid/kedaluwarsa', 'Token Google tidak valid'),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/oauth/github': {
    post: {
      tags: ['Auth'],
      summary: 'Login/registrasi via GitHub',
      description:
        '`code` berasal dari redirect callback OAuth GitHub di sisi frontend. Pertukaran ' +
        'code→access_token dilakukan di server (butuh GITHUB_CLIENT_SECRET).',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['code'],
              properties: { code: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Login berhasil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Login GitHub berhasil' },
                  data: { $ref: '#/components/schemas/AuthResponse' },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'GITHUB_CLIENT_ID/SECRET belum dikonfigurasi di server',
          'Login GitHub belum dikonfigurasi di server ini.'
        ),
        '401': errorResponse(
          'code tidak valid, atau akun GitHub tidak punya email publik/terverifikasi',
          'Kode otorisasi GitHub tidak valid'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/mfa/setup': {
    post: {
      tags: ['Auth'],
      summary: 'Mulai setup MFA untuk akun sendiri (langkah 1 dari 2)',
      description:
        'Menghasilkan secret TOTP baru (160-bit) + otpauthUrl untuk di-scan sebagai QR code. ' +
        'MFA BELUM aktif sampai dikonfirmasi lewat POST /auth/mfa/confirm. Memanggil endpoint ' +
        'ini lagi sebelum konfirmasi SENGAJA menimpa secret pending sebelumnya.',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Secret & otpauthUrl berhasil dibuat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example:
                      'Scan otpauthUrl sebagai QR code (atau masukkan secret manual) di authenticator app Anda, lalu konfirmasi lewat POST /auth/mfa/confirm',
                  },
                  data: {
                    type: 'object',
                    properties: {
                      secret: { type: 'string' },
                      otpauthUrl: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/mfa/confirm': {
    post: {
      tags: ['Auth'],
      summary: 'Konfirmasi setup MFA (langkah 2 dari 2) — mengaktifkan MFA',
      description:
        'Memverifikasi kode TOTP pertama benar-benar cocok dengan secret dari POST /auth/mfa/setup ' +
        'sebelum MFA benar-benar diaktifkan. Response berisi recovery codes (8 kode sekali-pakai) ' +
        'yang HANYA ditampilkan SATU KALI di sini — tidak bisa dilihat lagi setelahnya.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['code'],
              properties: { code: { type: 'string', example: '123456' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'MFA berhasil diaktifkan',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: {
                    type: 'string',
                    example:
                      'MFA berhasil diaktifkan. SIMPAN kode pemulihan berikut di tempat aman — kode ini TIDAK akan ditampilkan lagi.',
                  },
                  data: {
                    type: 'object',
                    properties: {
                      recoveryCodes: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '400': errorResponse(
          'Belum ada setup MFA yang berjalan (belum memanggil POST /auth/mfa/setup)',
          'Belum ada setup MFA yang berjalan — mulai dari POST /auth/mfa/setup'
        ),
        '401': errorResponse(
          'Kode TOTP tidak valid, atau access token tidak ada/tidak valid',
          'Kode MFA tidak valid'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/mfa/disable': {
    post: {
      tags: ['Auth'],
      summary: 'Nonaktifkan MFA pada akun sendiri',
      description:
        'Butuh re-autentikasi pakai PASSWORD (bukan kode TOTP) — supaya user yang kehilangan ' +
        'akses ke authenticator app tetap bisa menonaktifkan MFA.',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['password'],
              properties: { password: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'MFA berhasil dinonaktifkan',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'MFA berhasil dinonaktifkan' },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse(
          'Password salah, atau access token tidak ada/tidak valid',
          'Password salah'
        ),
        '422': validationErrorResponse,
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/sessions': {
    get: {
      tags: ['Auth'],
      summary: 'Daftar sesi/device yang sedang aktif (Phase 7)',
      description:
        'Satu baris RefreshToken merepresentasikan satu sesi/device. Kirim ' +
        '`?currentRefreshToken=...` (opsional) agar sesi yang sedang dipakai membuat ' +
        'request ini ditandai `isCurrent: true`.',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'currentRefreshToken',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'Daftar sesi berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Daftar sesi berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        userAgent: { type: 'string', nullable: true },
                        ipAddress: { type: 'string', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' },
                        expiresAt: { type: 'string', format: 'date-time' },
                        isCurrent: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '500': serverErrorResponse,
      },
    },
    delete: {
      tags: ['Auth'],
      summary: 'Cabut SELURUH sesi/device aktif milik akun sendiri ("Logout All Devices")',
      description:
        'Berbeda dari DELETE /auth/sessions/{id} (satu sesi tertentu) — endpoint ini mencabut ' +
        'semua refresh token milik user sekaligus, termasuk sesi yang sedang dipakai untuk ' +
        'memanggil endpoint ini sendiri (client harus login ulang setelahnya).',
      security: [{ bearerAuth: [] }],
      responses: {
        '200': {
          description: 'Seluruh sesi berhasil dicabut',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Seluruh sesi berhasil dicabut' },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/sessions/{id}': {
    delete: {
      tags: ['Auth'],
      summary: 'Mencabut satu sesi/device tertentu (Phase 7)',
      description:
        'Untuk kasus "logout dari device lain yang hilang/dicuri" — tidak butuh refresh ' +
        'token device tersebut di tangan, cukup ID sesinya (lihat GET /auth/sessions).',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Sesi berhasil dicabut',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Sesi berhasil dicabut' },
                  ...nullDataProps,
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '404': errorResponse(
          'Sesi tidak ditemukan, atau bukan milik user ini',
          'Sesi tidak ditemukan'
        ),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/login-history': {
    get: {
      tags: ['Auth'],
      summary: 'Riwayat login/logout milik user sendiri (Phase 7)',
      description: 'Dibaca dari AuditLog (Phase 5), difilter ke action LOGIN/LOGOUT saja.',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Riwayat login berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Riwayat login berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        action: { type: 'string', enum: ['LOGIN', 'LOGOUT'] },
                        ipAddress: { type: 'string', nullable: true },
                        userAgent: { type: 'string', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  meta: { $ref: '#/components/schemas/PaginationMeta' },
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '500': serverErrorResponse,
      },
    },
  },
  '/auth/admin/users/{id}/login-history': {
    get: {
      tags: ['Auth'],
      summary: 'Riwayat login/logout milik user LAIN (admin, Phase 9)',
      description:
        'Sama datanya dengan GET /auth/login-history, tapi untuk user manapun yang ID-nya ' +
        'diberikan di path — butuh permission `audit.read`, sengaja dipisah ke URL /admin/ ' +
        'sendiri (bukan diam-diam mengubah perilaku /login-history tergantung role).',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        '200': {
          description: 'Riwayat login user berhasil diambil',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Riwayat login user berhasil diambil' },
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        action: { type: 'string', enum: ['LOGIN', 'LOGOUT'] },
                        ipAddress: { type: 'string', nullable: true },
                        userAgent: { type: 'string', nullable: true },
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                  meta: { $ref: '#/components/schemas/PaginationMeta' },
                },
              },
            },
          },
        },
        '401': errorResponse('Access token tidak ada/tidak valid', 'Unauthorized'),
        '403': errorResponse(
          'User tidak punya permission audit.read',
          'Anda tidak punya izin untuk aksi ini'
        ),
        '500': serverErrorResponse,
      },
    },
  },
};
