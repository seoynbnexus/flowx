import { z } from 'zod';

export const createRoleSchema = z.object({
  code: z.string().min(2).max(50)
    .regex(/^[a-z_]+$/, 'Code must be lowercase with underscores'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  isSuperAdmin: z.boolean().optional().default(false),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
});
