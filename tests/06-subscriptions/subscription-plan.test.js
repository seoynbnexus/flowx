import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

const dateTag = Date.now()

describe('subscription plan CRUD', () => {
  let planId

  it('should list all plans', async () => {
    const plans = await subRepo.findAllPlans()
    expect(Array.isArray(plans)).toBe(true)
    expect(plans.length).toBeGreaterThanOrEqual(4)
    expect(plans[0]).toHaveProperty('monthlyPrice')
    expect(plans[0]).toHaveProperty('slug')
  })

  it('should create a plan', async () => {
    const plan = await subRepo.createPlan({
      name: `Test Plan ${dateTag}`,
      slug: `test-plan-${dateTag}`,
      description: 'A test subscription plan',
      monthlyPrice: 500,
      yearlyPrice: 5000,
      currency: 'INR',
      trialDays: 7,
      displayOrder: 99,
    })
    expect(plan.slug).toBe(`test-plan-${dateTag}`)
    expect(plan.monthlyPrice).toBe(500)
    expect(plan.isActive).toBe(true)
    planId = plan.id
  })

  it('should find plan by id', async () => {
    const plan = await subRepo.findPlanById(planId)
    expect(plan.id).toBe(planId)
    expect(plan.name).toContain('Test Plan')
  })

  it('should find plan by slug', async () => {
    const plan = await subRepo.findPlanBySlug(`test-plan-${dateTag}`)
    expect(plan).not.toBeNull()
  })

  it('should update a plan', async () => {
    const updated = await subRepo.updatePlan(planId, { monthlyPrice: 750, name: 'Updated Test Plan' })
    expect(updated.monthlyPrice).toBe(750)
    expect(updated.name).toBe('Updated Test Plan')
  })

  it('should update plan with isActive', async () => {
    const updated = await subRepo.updatePlan(planId, { isActive: false })
    expect(updated.isActive).toBe(false)
  })

  it('should delete a plan', async () => {
    await subRepo.deletePlan(planId)
    const plan = await subRepo.findPlanById(planId)
    expect(plan).toBeNull()
  })

  it('should return null for non-existent plan', async () => {
    const plan = await subRepo.findPlanById(generateUuid())
    expect(plan).toBeNull()
  })
})
