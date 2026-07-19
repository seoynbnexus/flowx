import { z } from 'zod'

export const createSubscriptionOrderSchema = z.object({
  planId: z.string().uuid(),
  billingCycle: z.enum(['monthly', 'yearly']).optional().default('monthly'),
})

export const createTopupOrderSchema = z.object({
  packageId: z.string().uuid(),
})

export const verifyPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
})

export const createPackageSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  coins: z.number().int().min(1),
  price: z.number().int().min(1),
  currency: z.string().length(3).optional().default('INR'),
  taxRate: z.number().min(0).max(100).optional().default(18),
  isActive: z.boolean().optional().default(true),
  displayOrder: z.number().int().min(0).optional().default(0),
})

export const updatePackageSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  coins: z.number().int().min(1).optional(),
  price: z.number().int().min(1).optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
})
