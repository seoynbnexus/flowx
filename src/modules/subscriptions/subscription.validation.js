import { z } from 'zod'

export const createPlanSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  description: z.string().max(1000).optional().nullable(),
  monthlyPrice: z.number().min(0),
  yearlyPrice: z.number().min(0),
  currency: z.string().length(3).optional().default('INR'),
  trialDays: z.number().int().min(0).optional().default(0),
  displayOrder: z.number().int().min(0).optional().default(0),
})

export const updatePlanSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional().nullable(),
  monthlyPrice: z.number().min(0).optional(),
  yearlyPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  trialDays: z.number().int().min(0).optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
})

export const createFeatureSchema = z.object({
  featureKey: z.string().min(1).max(100).regex(/^[a-z_]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  unit: z.string().max(50).optional().nullable(),
  isBoolean: z.boolean().optional().default(false),
})

export const updateFeatureSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  unit: z.string().max(50).optional().nullable(),
  isBoolean: z.boolean().optional(),
})

export const upsertPlanFeatureSchema = z.object({
  featureId: z.string().uuid(),
  isEnabled: z.boolean(),
  valueType: z.enum(['boolean', 'integer', 'unlimited']).optional().default('boolean'),
  valueInt: z.number().int().nullable().optional(),
})

export const bulkSetEntitlementsSchema = z.object({
  entitlements: z.array(z.object({
    featureId: z.string().uuid(),
    isEnabled: z.boolean(),
    valueType: z.enum(['boolean', 'integer', 'unlimited']).optional().default('boolean'),
    valueInt: z.number().int().nullable().optional(),
  })),
})

export const assignPlanSchema = z.object({
  planId: z.string().uuid(),
  status: z.enum(['active', 'trialing']).optional().default('active'),
  billingCycle: z.enum(['monthly', 'yearly']).optional().default('monthly'),
})

export const reorderPlansSchema = z.object({
  planIds: z.array(z.string().uuid()),
})

export const adminAdjustUsageSchema = z.object({
  userId: z.string().uuid(),
  featureKey: z.string().min(1).max(100),
  quantity: z.number().int().refine(v => v !== 0, 'Quantity must be non-zero'),
  reason: z.string().min(1).max(1000),
})

export const adminForceRefundSchema = z.object({
  userId: z.string().uuid(),
  featureKey: z.string().min(1).max(100),
  resourceType: z.string().min(1).max(100).optional().default('admin'),
  resourceId: z.string().optional().nullable(),
  reason: z.string().min(1).max(1000).optional().nullable(),
})
