import { z } from 'zod';

export const requestSelfErasureSchema = z.object({
  password: z.string().min(1, 'Konfirmasi password wajib diisi untuk penghapusan data'),
});

export type RequestSelfErasureDto = z.infer<typeof requestSelfErasureSchema>;
