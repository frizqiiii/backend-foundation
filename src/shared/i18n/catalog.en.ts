/**
 * Fase 2 (item 2.13 — i18n) — katalog terjemahan `id` -> `en`.
 *
 * SUMBER KEBENARAN teks tetap Indonesia yang ditulis di kode (service,
 * controller, DTO); katalog ini hanya menerjemahkannya di LAPIS OUTPUT
 * (`error-handler.ts`, `sendSuccess`, ...) untuk locale `en`. Kuncinya
 * adalah teks Indonesia PERSIS — kalau seseorang mengubah satu kata di
 * pesan sumber, terjemahannya diam-diam jatuh kembali ke Indonesia.
 * `catalog.spec.ts` menjaga itu: ia memindai seluruh pesan di kode dan
 * GAGAL kalau ada yang belum punya terjemahan (atau belum masuk daftar
 * pengecualian internal).
 *
 * Dua bagian:
 *   - `EN_MESSAGES`  : pesan STATIS (kecocokan persis).
 *   - `EN_TEMPLATES` : pesan DINAMIS. `{0}`, `{1}`, ... adalah
 *     penampung nilai (angka, nama tenant, status, dst.) yang diambil
 *     dari pesan Indonesia dan dipasang ulang di terjemahan; urutan
 *     nomor di kedua sisi boleh berbeda.
 *
 * Pesan yang TIDAK ada di sini sengaja tetap Indonesia untuk `en`
 * (fallback) — lihat `translate.ts`.
 */

export const EN_MESSAGES: Readonly<Record<string, string>> = {
  'Tenant ini telah melebihi kuota permintaan. Coba lagi dalam beberapa menit.':
    'This tenant has exceeded its request quota. Try again in a few minutes.',
  'Terlalu banyak percobaan autentikasi. Coba lagi dalam 15 menit.':
    'Too many authentication attempts. Try again in 15 minutes.',
  'Terlalu banyak permintaan dari IP ini. Coba lagi dalam beberapa menit.':
    'Too many requests from this IP. Try again in a few minutes.',
  'Daily active users berhasil diambil': 'Daily active users retrieved successfully',
  'API key berhasil dibuat. SIMPAN rawKey ini sekarang — tidak akan ditampilkan lagi.':
    'API key created successfully. SAVE this rawKey now — it will not be shown again.',
  'API key berhasil dicabut': 'API key revoked successfully',
  'Daftar API key berhasil diambil': 'API key list retrieved successfully',
  'Nama API key wajib diisi': 'API key name is required',
  'API key sudah dicabut': 'API key has been revoked',
  'API key sudah kedaluwarsa': 'API key has expired',
  'API key tidak ditemukan': 'API key not found',
  'API key tidak valid': 'Invalid API key',
  'expiresAt harus di masa depan': 'expiresAt must be in the future',
  'Daftar sesi berhasil diambil': 'Session list retrieved successfully',
  'Email berhasil diverifikasi': 'Email verified successfully',
  'Jika email terdaftar, instruksi reset password telah dikirim':
    'If the email is registered, password reset instructions have been sent',
  'Login GitHub berhasil': 'GitHub login successful',
  'Login Google berhasil': 'Google login successful',
  'Login berhasil': 'Login successful',
  'Logout berhasil': 'Logout successful',
  'Password berhasil direset. Silakan login ulang.':
    'Password reset successfully. Please log in again.',
  'Registrasi berhasil. Cek email untuk verifikasi akun.':
    'Registration successful. Check your email to verify your account.',
  'Riwayat login berhasil diambil': 'Login history retrieved successfully',
  'Riwayat login user berhasil diambil': 'User login history retrieved successfully',
  'Seluruh sesi berhasil dicabut': 'All sessions revoked successfully',
  'Sesi berhasil dicabut': 'Session revoked successfully',
  'Token berhasil diperbarui': 'Token refreshed successfully',
  'Verifikasi MFA diperlukan untuk menyelesaikan login':
    'MFA verification is required to complete login',
  'Format email tidak valid': 'Invalid email format',
  'Nama minimal 2 karakter': 'Name must be at least 2 characters',
  'Password minimal 8 karakter': 'Password must be at least 8 characters',
  'Password wajib diisi': 'Password is required',
  'code wajib diisi': 'code is required',
  'idToken wajib diisi': 'idToken is required',
  'refreshToken wajib diisi': 'refreshToken is required',
  'token wajib diisi': 'token is required',
  'Akun ini terdaftar lewat Google/GitHub. Gunakan tombol login yang sesuai.':
    'This account was registered via Google/GitHub. Use the matching login button.',
  'Challenge token tidak valid atau sudah kedaluwarsa': 'Challenge token is invalid or has expired',
  'Email atau password salah': 'Incorrect email or password',
  'Email belum diverifikasi. Silakan cek email Anda.':
    'Email not verified. Please check your email.',
  'Email sudah terdaftar': 'Email is already registered',
  'Kode MFA tidak valid': 'Invalid MFA code',
  'Refresh token sudah kedaluwarsa. Silakan login ulang.':
    'Refresh token has expired. Please log in again.',
  'Refresh token sudah tidak berlaku. Silakan login ulang.':
    'Refresh token is no longer valid. Please log in again.',
  'Refresh token tidak valid': 'Invalid refresh token',
  'Sesi sudah melewati batas maksimum. Silakan login ulang.':
    'Session has exceeded the maximum limit. Please log in again.',
  'Sesi tidak ditemukan': 'Session not found',
  'Token reset password tidak valid atau sudah kedaluwarsa':
    'Password reset token is invalid or has expired',
  'Token verifikasi tidak valid atau sudah kedaluwarsa':
    'Verification token is invalid or has expired',
  'MFA berhasil diaktifkan. SIMPAN kode pemulihan berikut di tempat aman — kode ini TIDAK akan ditampilkan lagi.':
    'MFA enabled successfully. SAVE the following recovery codes in a safe place — these codes will NOT be shown again.',
  'MFA berhasil dinonaktifkan': 'MFA disabled successfully',
  'Password salah': 'Incorrect password',
  'Scan otpauthUrl sebagai QR code (atau masukkan secret manual) di authenticator app Anda, lalu konfirmasi lewat POST /auth/mfa/confirm':
    'Scan the otpauthUrl as a QR code (or enter the secret manually) in your authenticator app, then confirm via POST /auth/mfa/confirm',
  'User tidak ditemukan': 'User not found',
  'Challenge token wajib diisi': 'Challenge token is required',
  'Kode harus 6 digit': 'Code must be 6 digits',
  'Kode harus berupa 6 angka': 'Code must be 6 numbers',
  'Kode tidak valid': 'Invalid code',
  'Belum ada setup MFA yang berjalan — mulai dari POST /auth/mfa/setup':
    'No MFA setup is in progress — start from POST /auth/mfa/setup',
  'Akun GitHub ini tidak memiliki email publik/terverifikasi yang bisa dipakai untuk login':
    'This GitHub account has no public/verified email that can be used to log in',
  'Akun tidak ditemukan': 'Account not found',
  'Gagal mengambil profil GitHub': 'Failed to fetch GitHub profile',
  'Login GitHub belum dikonfigurasi di server ini.':
    'GitHub login is not configured on this server.',
  'Login Google belum dikonfigurasi di server ini.':
    'Google login is not configured on this server.',
  'Token Google tidak valid': 'Invalid Google token',
  'Konfigurasi SSO tenant berhasil diambil': 'Tenant SSO configuration retrieved successfully',
  'Konfigurasi SSO tenant berhasil disimpan': 'Tenant SSO configuration saved successfully',
  'Login SSO berhasil': 'SSO login successful',
  'SSO_FRONTEND_CALLBACK_URL belum dikonfigurasi di server ini.':
    'SSO_FRONTEND_CALLBACK_URL is not configured on this server.',
  'Tenant ini belum punya konfigurasi SSO': 'This tenant has no SSO configuration yet',
  'Parameter state wajib ada (perlindungan CSRF/replay)':
    'The state parameter is required (CSRF/replay protection)',
  'allowedEmailDomain harus berupa domain valid, mis. "acme.com" (tanpa "@" atau path)':
    'allowedEmailDomain must be a valid domain, e.g. "acme.com" (without "@" or a path)',
  'issuerUrl harus URL valid, mis. https://login.microsoftonline.com/<tenant>/v2.0':
    'issuerUrl must be a valid URL, e.g. https://login.microsoftonline.com/<tenant>/v2.0',
  'Email ini sudah terdaftar di tenant lain — SSO tidak menautkan lintas-tenant.':
    'This email is already registered in another tenant — SSO does not link across tenants.',
  'Identity provider tidak mengembalikan klaim email pada id_token.':
    'The identity provider did not return an email claim in the id_token.',
  'Kode tukar SSO tidak valid, sudah dipakai, atau kedaluwarsa.':
    'The SSO exchange code is invalid, already used, or expired.',
  'Parameter code tidak ada pada callback SSO.':
    'The code parameter is missing from the SSO callback.',
  'SSO belum dikonfigurasi di server ini (APP_BASE_URL kosong).':
    'SSO is not configured on this server (APP_BASE_URL is empty).',
  'SSO belum dikonfigurasi/tidak aktif untuk tenant ini.':
    'SSO is not configured/active for this tenant.',
  'SSO memerlukan Redis, yang belum dikonfigurasi di server ini.':
    'SSO requires Redis, which is not configured on this server.',
  'Sesi login SSO ini sudah kedaluwarsa, sudah dipakai, atau tidak valid — silakan login ulang.':
    'This SSO login session has expired, was already used, or is invalid — please log in again.',
  'State tidak cocok dengan tenant pada URL callback ini.':
    'The state does not match the tenant in this callback URL.',
  'Tenant tidak ditemukan': 'Tenant not found',
  'Ringkasan audit log berhasil diambil': 'Audit log summary retrieved successfully',
  'Statistik dashboard berhasil diambil': 'Dashboard statistics retrieved successfully',
  'from dan to harus diisi bersamaan, atau dikosongkan berdua':
    'from and to must be provided together, or both left empty',
  'Daftar event berhasil diambil': 'Event list retrieved successfully',
  'Detail event berhasil diambil': 'Event details retrieved successfully',
  'Event berhasil dibuat': 'Event created successfully',
  'Event berhasil dihapus': 'Event deleted successfully',
  'Event berhasil diperbarui': 'Event updated successfully',
  'Format tanggal tidak valid': 'Invalid date format',
  'Judul minimal 3 karakter': 'Title must be at least 3 characters',
  'Kategori wajib diisi': 'Category is required',
  'Lokasi wajib diisi': 'Location is required',
  'dateFrom harus sebelum atau sama dengan dateTo': 'dateFrom must be before or equal to dateTo',
  'Anda hanya bisa mengubah atau menghapus event milik Anda sendiri':
    'You can only modify or delete your own events',
  'Event tidak ditemukan': 'Event not found',
  'Permintaan export diterima': 'Export request accepted',
  'Status export': 'Export status',
  'Export tidak ditemukan': 'Export not found',
  'Daftar feature flag berhasil diambil': 'Feature flag list retrieved successfully',
  'Feature flag berhasil diperbarui': 'Feature flag updated successfully',
  'Webhook diterima': 'Webhook received',
  'Webhook secret tidak valid': 'Invalid webhook secret',
  'Proses sedang shutdown': 'Process is shutting down',
  'Data pribadi Anda berhasil dihapus permanen': 'Your personal data has been permanently deleted',
  'Data pribadi user berhasil dihapus permanen':
    "The user's personal data has been permanently deleted",
  'Konfirmasi password wajib diisi untuk penghapusan data':
    'Password confirmation is required for data deletion',
  'Data user ini sudah pernah di-erasure sebelumnya.': "This user's data has already been erased.",
  'Password salah — penghapusan data dibatalkan.': 'Incorrect password — data deletion cancelled.',
  'Daftar produk berhasil diambil': 'Product list retrieved successfully',
  'Produk berhasil di-upgrade': 'Product upgraded successfully',
  'Produk berhasil dibuat': 'Product created successfully',
  'Produk berhasil dihapus': 'Product deleted successfully',
  'Deskripsi minimal 10 karakter': 'Description must be at least 10 characters',
  'Harga harus berupa angka': 'Price must be a number',
  'Harga harus bilangan bulat': 'Price must be an integer',
  'Kategori tujuan harus FEATURED atau PREMIUM': 'Target category must be FEATURED or PREMIUM',
  'Anda hanya bisa meng-upgrade produk milik Anda sendiri':
    'You can only upgrade your own products',
  'Anda hanya bisa menghapus produk milik Anda sendiri': 'You can only delete your own products',
  'Harga produk tidak boleh negatif': 'Product price must not be negative',
  'Produk tidak ditemukan': 'Product not found',
  'Stok produk habis, tidak bisa di-upgrade': 'Product is out of stock and cannot be upgraded',
  'Statistik event berhasil diambil': 'Event statistics retrieved successfully',
  'Statistik produk berhasil diambil': 'Product statistics retrieved successfully',
  'Statistik sistem berhasil diambil': 'System statistics retrieved successfully',
  'Statistik user berhasil diambil': 'User statistics retrieved successfully',
  'Daftar tenant berhasil diambil': 'Tenant list retrieved successfully',
  'Plan tenant berhasil diperbarui': 'Tenant plan updated successfully',
  'Tenant berhasil dibuat': 'Tenant created successfully',
  'Slug hanya boleh huruf kecil, angka, dan tanda hubung':
    'Slug may only contain lowercase letters, numbers, and hyphens',
  'File berhasil dihapus': 'File deleted successfully',
  'File berhasil diupload': 'File uploaded successfully',
  'Metadata file berhasil diambil': 'File metadata retrieved successfully',
  'Tidak ada file yang dikirim. Sertakan field "file".':
    'No file was sent. Include the "file" field.',
  'Anda hanya bisa mengakses atau menghapus file milik Anda sendiri':
    'You can only access or delete your own files',
  'File tidak ditemukan': 'File not found',
  'Daftar user berhasil diambil': 'User list retrieved successfully',
  'Profil berhasil diambil': 'Profile retrieved successfully',
  'User berhasil dihapus': 'User deleted successfully',
  'Daftar webhook endpoint berhasil diambil': 'Webhook endpoint list retrieved successfully',
  'Webhook endpoint berhasil dicabut': 'Webhook endpoint revoked successfully',
  'Webhook endpoint berhasil didaftarkan. SIMPAN secret ini sekarang — tidak akan ditampilkan lagi.':
    'Webhook endpoint registered successfully. SAVE this secret now — it will not be shown again.',
  'Minimal satu event type harus dipilih': 'At least one event type must be selected',
  'URL tidak valid': 'Invalid URL',
  'Webhook endpoint tidak ditemukan': 'Webhook endpoint not found',
  'Pemilik API key ini tidak ditemukan': 'The owner of this API key was not found',
  'Token sudah dicabut (revoked). Silakan login ulang.':
    'Token has been revoked. Please log in again.',
  'Token sudah kadaluarsa': 'Token has expired',
  'Token tidak ditemukan. Sertakan header Authorization: Bearer <token>':
    'Token not found. Include the header Authorization: Bearer <token>',
  'Token tidak valid': 'Invalid token',
  'Request dengan Idempotency-Key yang sama sedang diproses. Coba lagi sesaat lagi.':
    'A request with the same Idempotency-Key is already being processed. Try again shortly.',
  'Hostname tidak bisa di-resolve': 'Hostname could not be resolved',
  'URL harus memakai skema http atau https': 'URL must use the http or https scheme',
  'URL menunjuk ke alamat IP yang tidak diizinkan': 'URL points to a disallowed IP address',
  'URL menunjuk ke host yang tidak diizinkan': 'URL points to a disallowed host',
  'Token bukan token MFA challenge yang valid': 'Token is not a valid MFA challenge token',
  'Ukuran file melebihi batas maksimal yang diizinkan':
    'File size exceeds the maximum allowed limit',
  'Kode otorisasi GitHub tidak valid': 'Invalid GitHub authorization code',
};

export const EN_TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  [
    'Origin {0} tidak diizinkan oleh kebijakan CORS',
    'Origin {0} is not allowed by the CORS policy',
  ],
  ['days harus berupa bilangan bulat antara {0}-{1}', 'days must be an integer between {0}-{1}'],
  [
    'Scope berikut melebihi permission Anda sendiri: {0}',
    'The following scopes exceed your own permissions: {0}',
  ],
  [
    'Terlalu banyak percobaan login gagal. Coba lagi dalam {0} menit.',
    'Too many failed login attempts. Try again in {0} minutes.',
  ],
  [
    'Terlalu banyak percobaan kode MFA gagal. Coba lagi dalam {0} menit.',
    'Too many failed MFA code attempts. Try again in {0} minutes.',
  ],
  ["Tenant '{0}' tidak ditemukan", "Tenant '{0}' not found"],
  [
    'Login SSO ditolak oleh identity provider: {0}',
    'SSO login was rejected by the identity provider: {0}',
  ],
  [
    "Email '{0}' bukan bagian dari domain yang diizinkan ({1}) untuk tenant ini.",
    "Email '{0}' is not part of the allowed domain ({1}) for this tenant.",
  ],
  [
    'Export belum siap diunduh (status saat ini: {0})',
    'Export is not ready for download (current status: {0})',
  ],
  [
    'Produk berstatus {0} tidak bisa di-upgrade. Hanya produk ACTIVE yang bisa di-upgrade.',
    'A product with status {0} cannot be upgraded. Only ACTIVE products can be upgraded.',
  ],
  [
    'Tidak bisa upgrade dari {0} ke {1} — kategori tujuan harus lebih tinggi dari kategori saat ini',
    'Cannot upgrade from {0} to {1} — the target category must be higher than the current category',
  ],
  ['Tenant dengan slug "{0}" sudah terdaftar', 'A tenant with slug "{0}" is already registered'],
  [
    'Tenant "{0}" tidak ditemukan atau sedang tidak aktif',
    'Tenant "{0}" was not found or is inactive',
  ],
  [
    'Isi file tidak cocok dengan tipe yang diklaim ({0})',
    'File content does not match the claimed type ({0})',
  ],
  ['Request lintas-origin dari "{0}" ditolak.', 'Cross-origin request from "{0}" was rejected.'],
  ['Aksi ini membutuhkan permission: {0}', 'This action requires permission: {0}'],
  ['API key ini tidak memiliki scope: {0}', 'This API key does not have the scope: {0}'],
  ['Aksi ini hanya untuk role: {0}', 'This action is only for role: {0}'],
  [
    'Tipe file {0} tidak diizinkan. Hanya image/pdf.',
    'File type {0} is not allowed. Only image/pdf.',
  ],
  [
    'Kuota API key terlampaui (maks {0} request/menit). Coba lagi sesaat lagi.',
    'API key quota exceeded (max {0} requests/minute). Try again shortly.',
  ],
  ['Kode otorisasi GitHub tidak valid: {0}', 'Invalid GitHub authorization code: {0}'],
  ['Upload gagal: {0}', 'Upload failed: {0}'],
];
