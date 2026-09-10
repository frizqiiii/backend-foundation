/**
 * Union provider OAuth — mengikuti pola yang sama seperti `RoleName`
 * di `role.ts`: didefinisikan lokal, bukan diimpor dari
 * `@prisma/client`, supaya Service/Controller tidak perlu tahu detail
 * tipe hasil generate ORM. Nilai harus tetap identik dengan enum
 * `OAuthProvider` di `schema.prisma`.
 */
export type OAuthProviderName = 'GOOGLE' | 'GITHUB';
