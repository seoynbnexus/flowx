import { z } from 'zod'

const PROMOTION_OBJECTIVES = ['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT']
const PROMOTION_GOALS = ['REACH', 'IMPRESSIONS', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'POST_ENGAGEMENT', 'PAGE_LIKES', 'THRUPLAY', 'CONVERSATIONS']

export const createPromotionSchema = z.object({
  budgetType: z.enum(['daily', 'lifetime']),
  budgetAmount: z.coerce.number().positive(),
  spendCap: z.coerce.number().positive().optional().nullable(),
  endTime: z.string().datetime().optional().nullable(),
  objective: z.enum(PROMOTION_OBJECTIVES).optional().nullable(),
  optimizationGoal: z.enum(PROMOTION_GOALS).optional().nullable(),
  bidStrategy: z.string().max(100).optional().nullable(),
  targeting: z.any().optional().nullable(),
  placement: z.any().optional().nullable(),
  callToAction: z.string().max(100).optional().nullable(),
  link: z.string().url().max(2000).optional().nullable().or(z.literal('').transform(() => null)),
  headline: z.string().max(255).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.budgetType === 'lifetime' && !data.endTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endTime'],
      message: 'Lifetime budget requires an end time',
    })
  }
})
