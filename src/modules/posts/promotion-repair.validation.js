import { z } from 'zod'

export const promotionRepairRequestSchema = z.object({
  callToAction: z.string().max(100).optional().nullable(),
  issueCode: z.string().max(32).optional().nullable(),
})
