import { z } from 'zod';

export const listDocumentsQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected']).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const verifyDocumentSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  rejectedReason: z.string().max(500).optional().nullable(),
});
