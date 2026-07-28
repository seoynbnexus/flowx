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

const geoLocationFields = {
  countries: z.array(z.string()).optional(),
  regions: z.array(z.object({ key: z.string() })).optional(),
  cities: z.array(z.object({ key: z.string() })).optional(),
  zips: z.array(z.object({ key: z.string() })).optional(),
  location_types: z.array(z.string()).optional(),
}

const targetingMetaItem = z.object({ id: z.string(), name: z.string() })

export const metaSettingsSchema = z.object({
  objective: z.string().min(1, 'Objective is required'),
  adAccountId: z.string().optional().nullable(),
  bidStrategy: z.string().optional().nullable(),
  optimizationGoal: z.string().optional().nullable(),
  budgetType: z.nativeEnum(BUDGET_TYPES).optional().nullable(),
  budgetAmount: z.coerce.number().positive().optional().nullable(),
  billingEvent: z.string().optional().nullable(),
  targeting: z.object({
    age_min: z.number().int().min(13).max(65).optional(),
    age_max: z.number().int().min(13).max(65).optional(),
    genders: z.array(z.number().int().min(1).max(2)).optional(),
    geo_locations: z.object(geoLocationFields).optional(),
    excluded_geo_locations: z.object(geoLocationFields).optional(),
    interests: z.array(targetingMetaItem).optional(),
    behaviors: z.array(targetingMetaItem).optional(),
    languages: z.array(targetingMetaItem).optional(),
    device_platforms: z.array(z.enum(['mobile', 'desktop'])).optional(),
  }).optional().default({}),
  platformPlacement: z.object({
    publisher_platforms: z.array(z.string()).optional(),
    facebook_positions: z.array(z.enum(['feed', 'video_feeds', 'story', 'marketplace', 'reels', 'in_stream', 'search'])).optional(),
    instagram_positions: z.array(z.enum(['stream', 'story', 'explore', 'reels', 'search'])).optional(),
    messenger_positions: z.array(z.enum(['messenger_home', 'story'])).optional(),
    audience_network_positions: z.array(z.enum(['native', 'banner', 'interstitial', 'rewarded_video'])).optional(),
  }).optional().default({}),
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

export const coinConversionRateSchema = z.object({
  rate: z.coerce.number().positive('Rate must be positive').max(10000, 'Rate too high'),
})

export const publisherRequestActionSchema = z.object({
  requestId: z.string().uuid('Invalid request ID'),
})
