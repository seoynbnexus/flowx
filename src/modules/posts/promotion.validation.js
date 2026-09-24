import { z } from 'zod'
import { META_SPECIAL_AD_CATEGORIES } from '../campaigns/campaign.model.js'

const PROMOTION_OBJECTIVES = ['OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT']
const PROMOTION_GOALS = ['REACH', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'POST_ENGAGEMENT']

export const createPromotionSchema = z.object({
  budgetType: z.enum(['daily', 'lifetime']),
  budgetAmount: z.coerce.number().positive(),
  spendCap: z.coerce.number().positive().optional().nullable(),
  endTime: z.string().datetime().optional().nullable(),
  objective: z.enum(PROMOTION_OBJECTIVES).optional().nullable(),
  optimizationGoal: z.enum(PROMOTION_GOALS).optional().nullable(),
  bidStrategy: z.string().max(100).optional().nullable(),
  bidAmount: z.coerce.number().positive().optional().nullable(),
  specialAdCategories: z.array(z.enum(META_SPECIAL_AD_CATEGORIES)).optional().default([]),
  targeting: z.record(z.string(), z.any()).optional().nullable(),
  placement: z.record(z.string(), z.any()).optional().nullable(),
  callToAction: z.string().max(100).optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.budgetType === 'lifetime' && !data.endTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'Lifetime budget requires an end time',
    })
  }
})
