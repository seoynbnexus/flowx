import { z } from 'zod'
import { POST_TYPES } from './post.model.js'

const contentFields = {
  caption: z.string().max(2200).optional().nullable(),
  mediaUrl: z.string().max(2000).optional().nullable(),
  hashtags: z.string().max(500).optional().nullable(),
  textBody: z.string().max(5000).optional().nullable(),
}

const BOOST_OBJECTIVES = ['OUTCOME_AWARENESS','OUTCOME_TRAFFIC','OUTCOME_ENGAGEMENT']
const BOOST_GOALS = ['REACH','IMPRESSIONS','LINK_CLICKS','LANDING_PAGE_VIEWS','POST_ENGAGEMENT','PAGE_LIKES','THRUPLAY','CONVERSATIONS']
const boostFields = {
  boostEnabled: z.boolean().optional().default(false),
  boostBudgetType: z.enum(['daily', 'lifetime']).optional().nullable(),
  boostBudgetAmount: z.coerce.number().positive().optional().nullable(),
  boostSpendCap: z.coerce.number().positive().optional().nullable(),
  boostEndTime: z.string().datetime().optional().nullable(),
  boostTargeting: z.any().optional().nullable(),
  boostPlacement: z.any().optional().nullable(),
  boostBidStrategy: z.string().max(100).optional().nullable(),
  boostOptimizationGoal: z.enum(BOOST_GOALS).optional().nullable(),
  boostObjective: z.enum(BOOST_OBJECTIVES).optional().nullable(),
  boostCallToAction: z.string().max(100).optional().nullable(),
  boostLink: z.string().url().max(2000).optional().nullable().or(z.literal('').transform(() => null)),
  boostHeadline: z.string().max(255).optional().nullable(),
  boostDescription: z.string().max(500).optional().nullable(),
}

const boostRefine = (schema) =>
  schema.superRefine((data, ctx) => {
    if (!data.boostEnabled) {
      if (data.boostBudgetAmount || data.boostSpendCap || data.boostEndTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['boostEnabled'],
          message: 'Budget/spend cap/end time require boost to be enabled',
        })
      }
      return
    }
    if (!data.boostBudgetAmount || data.boostBudgetAmount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boostBudgetAmount'],
        message: 'Boost requires a budget amount',
      })
    }
    const budgetType = data.boostBudgetType || 'daily'
    if (budgetType === 'lifetime' && !data.boostEndTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boostEndTime'],
        message: 'Lifetime boost requires an end time',
      })
    }
  })

const postTypeRefine = (schema) =>
  schema.superRefine((data, ctx) => {
    const type = data.type || 'post'
    const hasCaptionContent = !!(data.caption || data.hashtags || data.textBody)
    if (type === 'story' && hasCaptionContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caption'],
        message: 'Stories do not support captions, hashtags or text body — media only',
      })
    }
    if ((type === 'story' || type === 'reel') && !data.mediaUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaUrl'],
        message: `${type === 'reel' ? 'Reels' : 'Stories'} require a media URL`,
      })
    }
    if (type === 'reel' && data.mediaUrl && !/\.(mp4|mov)(\?.*)?$/i.test(data.mediaUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaUrl'],
        message: 'Reels require a video media URL (.mp4 or .mov)',
      })
    }
  })

export const createPostSchema = boostRefine(postTypeRefine(z.object({
  name: z.string().min(1, 'Name is required').max(255),
  type: z.nativeEnum(POST_TYPES).default('post'),
  categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  runOnPublishers: z.boolean().optional().default(false),
  publisherCount: z.coerce.number().int().positive().optional().nullable(),
  coinsPerPublisher: z.coerce.number().positive().optional().nullable(),
  targetAccountIds: z.array(z.string().uuid('Invalid account ID')).min(1, 'Select at least one target account').optional(),
  ...contentFields,
  ...boostFields,
})))

export const updatePostSchema = postTypeRefine(z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.nativeEnum(POST_TYPES).optional(),
  categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  runOnPublishers: z.boolean().optional(),
  publisherCount: z.coerce.number().int().positive().optional().nullable(),
  coinsPerPublisher: z.coerce.number().positive().optional().nullable(),
  targetAccountIds: z.array(z.string().uuid('Invalid account ID')).min(1).optional(),
  ...contentFields,
}))

export const postTargetsSchema = z.object({
  targetAccountIds: z.array(z.string().uuid('Invalid account ID')).min(1, 'Select at least one target account'),
})

export const postQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
})

export const adminPostQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  clientId: z.string().uuid().optional(),
})

export const approvePostSchema = z.object({
  notes: z.string().max(1000).optional().nullable(),
})

export const rejectPostSchema = z.object({
  notes: z.string().min(1, 'Rejection notes are required').max(1000),
})

export const duplicatePostSchema = z.object({
  name: z.string().min(1).max(255).optional(),
})
