import { z } from 'zod';

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  code: z.string().min(1, 'Code is required').max(50).regex(/^[a-z0-9_]+$/, 'Code must be lowercase alphanumeric with underscores'),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(50).optional().nullable(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  icon: z.string().max(50).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const setUserCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid('Invalid category ID')).min(1, 'At least one category is required'),
});
