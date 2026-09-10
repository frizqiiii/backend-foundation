/**
 * Union role aplikasi — SENGAJA didefinisikan sebagai literal type di
 * sini, bukan diimpor dari `@prisma/client` (`Role` enum hasil
 * generate). Alasan:
 *
 * 1. Decoupling — layer Service/Middleware/RBAC tidak perlu tahu
 *    detail implementasi ORM; hanya Repository yang boleh bicara
 *    langsung dengan tipe hasil generate Prisma.
 * 2. Nilai enum Prisma di database tetap string yang sama persis
 *    ("ADMIN"/"ORGANIZER"/"USER"), jadi 100% kompatibel secara
 *    runtime tanpa konversi apa pun — union ini murni pemisahan tipe,
 *    bukan pemetaan nilai.
 *
 * PENTING: kalau menambah role baru, perbarui union ini DAN
 * `enum Role` di `prisma/schema.prisma` secara bersamaan — keduanya
 * harus tetap identik.
 */
export type RoleName = 'ADMIN' | 'ORGANIZER' | 'USER';
