import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from '../src/shared/tenant/tenant.constants';

/**
 * Seed data untuk environment development/staging — BUKAN untuk
 * production (kredensial di bawah ini dikenal publik lewat repo).
 *
 * Idempotent: memakai `upsert` dengan `email` sebagai kunci unik, jadi
 * aman dijalankan berulang kali (`npm run db:seed`) tanpa membuat
 * duplikat atau error constraint violation.
 */
const prisma = new PrismaClient();

const SEED_PASSWORD = 'Password123'; // sama untuk semua akun seed — HANYA untuk development

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  // Phase 11 — upsert tenant default dengan id yang SAMA PERSIS
  // dengan yang di-insert oleh migration
  // `20260801000000_multi_tenancy_foundation` (lihat
  // `DEFAULT_TENANT_ID`). `upsert` di sini idempoten dan aman
  // dijalankan berulang, TERMASUK di database yang migration-nya
  // sudah pernah jalan (tidak membuat baris duplikat).
  const defaultTenant = await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: {
      id: DEFAULT_TENANT_ID,
      slug: DEFAULT_TENANT_SLUG,
      name: 'Default Tenant (pre-Phase 11 legacy data)',
    },
  });

  // Tenant kedua HANYA untuk keperluan development/demo — supaya ada
  // sesuatu yang nyata untuk memverifikasi isolasi tenant benar-benar
  // bekerja (lihat langkah verifikasi Phase 11), bukan cuma satu
  // tenant yang tidak membuktikan apa-apa soal isolasi.
  const acmeTenant = await prisma.tenant.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { slug: 'acme', name: 'Acme Corp (demo tenant)' },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: passwordHash,
      name: 'Admin Utama',
      role: 'ADMIN',
      tenantId: defaultTenant.id,
    },
  });

  const organizer = await prisma.user.upsert({
    where: { email: 'organizer@example.com' },
    update: {},
    create: {
      email: 'organizer@example.com',
      password: passwordHash,
      name: 'Budi Organizer',
      role: 'ORGANIZER',
      tenantId: defaultTenant.id,
    },
  });

  const regularUser = await prisma.user.upsert({
    where: { email: 'user@example.com' },
    update: {},
    create: {
      email: 'user@example.com',
      password: passwordHash,
      name: 'Sari Pengguna',
      role: 'USER',
      tenantId: defaultTenant.id,
    },
  });

  // User milik tenant "acme" — demo user + produk di bawah sengaja
  // dipisah ke tenant lain untuk membuktikan isolasi (lihat langkah
  // verifikasi di respons/dokumentasi Phase 11).
  const acmeUser = await prisma.user.upsert({
    where: { email: 'user@acme.example.com' },
    update: {},
    create: {
      email: 'user@acme.example.com',
      password: passwordHash,
      name: 'Acme Demo User',
      role: 'USER',
      tenantId: acmeTenant.id,
    },
  });

  await prisma.product.upsert({
    where: { id: 'seed-product-keyboard' },
    update: {},
    create: {
      id: 'seed-product-keyboard',
      title: 'Keyboard Mekanik 60%',
      description: 'Keyboard mekanik compact dengan switch hot-swappable.',
      price: 850000,
      category: 'FEATURED',
      status: 'ACTIVE',
      stock: 12,
      userId: regularUser.id,
      tenantId: defaultTenant.id,
    },
  });

  await prisma.product.upsert({
    where: { id: 'seed-product-mouse' },
    update: {},
    create: {
      id: 'seed-product-mouse',
      title: 'Mouse Wireless Ergonomis',
      description: 'Mouse wireless dengan baterai tahan hingga 3 bulan.',
      price: 320000,
      category: 'STANDARD',
      status: 'ACTIVE',
      stock: 25,
      userId: regularUser.id,
      tenantId: defaultTenant.id,
    },
  });

  // Produk demo milik tenant "acme" — HARUS tidak pernah muncul saat
  // listing dengan header `X-Tenant-ID: default`, dan sebaliknya.
  await prisma.product.upsert({
    where: { id: 'seed-product-acme-monitor' },
    update: {},
    create: {
      id: 'seed-product-acme-monitor',
      title: 'Monitor 27" 144Hz',
      description: 'Monitor gaming milik tenant Acme — produk demo isolasi tenant.',
      price: 3200000,
      category: 'FEATURED',
      status: 'ACTIVE',
      stock: 5,
      userId: acmeUser.id,
      tenantId: acmeTenant.id,
    },
  });

  await prisma.event.upsert({
    where: { id: 'seed-event-conf' },
    update: {},
    create: {
      id: 'seed-event-conf',
      title: 'Konferensi TypeScript Indonesia 2026',
      description: 'Konferensi tahunan seputar TypeScript dan backend modern.',
      category: 'Teknologi',
      location: 'Jakarta',
      date: new Date('2026-11-15T09:00:00.000Z'),
      ownerId: organizer.id,
      tenantId: defaultTenant.id,
    },
  });

  await prisma.event.upsert({
    where: { id: 'seed-event-workshop' },
    update: {},
    create: {
      id: 'seed-event-workshop',
      title: 'Workshop Backend Security',
      description: 'Workshop praktis hardening keamanan backend.',
      category: 'Workshop',
      location: 'Bandung',
      date: new Date('2026-12-05T13:00:00.000Z'),
      ownerId: organizer.id,
      tenantId: defaultTenant.id,
    },
  });

  console.log('Seed selesai:');
  console.log(`  - Tenant: ${defaultTenant.slug} (default), ${acmeTenant.slug} (demo)`);
  console.log(`  - ${admin.email} (ADMIN, tenant: ${defaultTenant.slug})`);
  console.log(`  - ${organizer.email} (ORGANIZER, tenant: ${defaultTenant.slug})`);
  console.log(`  - ${regularUser.email} (USER, tenant: ${defaultTenant.slug})`);
  console.log(`  - ${acmeUser.email} (USER, tenant: ${acmeTenant.slug})`);
  console.log(`  - Password untuk semua akun seed: ${SEED_PASSWORD}`);
}

main()
  .catch((error) => {
    console.error('Seed gagal:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
