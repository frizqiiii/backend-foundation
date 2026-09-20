import type { AuditAction } from '@prisma/client';

/**
 * Konteks requester — SELALU sama untuk setiap panggilan audit dari
 * satu request HTTP yang sama, jadi dikumpulkan jadi satu tipe supaya
 * tidak perlu meneruskan 3 parameter terpisah (userId, ip, userAgent)
 * di setiap pemanggilan method `AuditService`.
 */
export interface AuditActorContext {
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateAuditLogInput extends AuditActorContext {
  action: AuditAction;
  entity: string;
  entityId: string | null;
  /**
   * Temuan T2 — konteks perubahan sebagai TEKS JSON (lihat komentar `AuditLog.details`
   * di `schema.prisma`). Opsional; tanpa ini baris tetap valid dan hash-nya identik dengan
   * sebelum kolom ini ada. JANGAN berisi data pribadi (PII): baris audit tidak bisa dihapus.
   */
  details?: string | null;
}

export type { AuditAction };
