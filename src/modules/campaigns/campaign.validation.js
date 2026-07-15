import { z } from 'zod'
import { CAMPAIGN_TYPES, BUDGET_TYPES } from './campaign.model.js'

export const createCampaignSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  type: z.nativeEnum(CAMPAIGN_TYPES).default('post'),
  categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  publisherCount: z.coerce.number().int().positive().optional().nullable(),
  coinsPerPublisher: z.coerce.number().positive().optional().nullable(),
})

export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.nativeEnum(CAMPAIGN_TYPES).optional(),
  categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  publisherCount: z.coerce.number().int().positive().optional().nullable(),
  coinsPerPublisher: z.coerce.number().positive().optional().nullable(),
})

export const creativeSchema = z.object({
  mediaUrl: z.string().url('Invalid media URL').optional().nullable(),
  caption: z.string().max(2200).optional().nullable(),
  hashtags: z.string().max(500).optional().nullable(),
  textBody: z.string().max(5000).optional().nullable(),
  callToAction: z.string().max(100).optional().nullable(),
})

export const metaSettingsSchema = z.object({
  objective: z.string().min(1, 'Objective is required'),
  adAccountId: z.string().optional().nullable(),
  bidStrategy: z.string().optional().nullable(),
  optimizationGoal: z.string().optional().nullable(),
  budgetType: z.nativeEnum(BUDGET_TYPES).optional().nullable(),
  budgetAmount: z.coerce.number().positive().optional().nullable(),
  targeting: z.record(z.unknown()).optional().default({}),
  platformPlacement: z.record(z.unknown()).optional().default({}),
})

export const campaignQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
})

export const adminCampaignQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  clientId: z.string().uuid().optional(),
})

export const approveCampaignSchema = z.object({
  notes: z.string().max(1000).optional().nullable(),
  publisherCount: z.coerce.number().int().positive().optional().nullable(),
  coinsPerPublisher: z.coerce.number().positive().optional().nullable(),
})

export const rejectCampaignSchema = z.object({
  notes: z.string().min(1, 'Rejection notes are required').max(1000),
})

export const publisherRequestActionSchema = z.object({
  requestId: z.string().uuid('Invalid request ID'),
})
