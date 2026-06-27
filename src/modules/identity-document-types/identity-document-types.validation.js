import { z } from 'zod';

export const createDocumentTypeSchema = z.object({
  code: z.string().min(1).max(100).regex(/^[a-z_]+$/, 'Code must be lowercase with underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional().nullable(),
  isMandatory: z.boolean().optional().default(false),
});

export const updateDocumentTypeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  isMandatory: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
