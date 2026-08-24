import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'

let app
const tag = Date.now()

describe('dashboard endpoints', () => {
  let clientToken, publisherToken, adminToken
  let clientId, publisherId

  beforeAll(async () => {
    const mod = await import('../../app.js')
    app = mod.default
    const client = await createTestUser({ email: `dash-client-${tag}@flowx-test.com`, password: 'Test@123', role: 'client' })
    clientId = client.id
    clientToken = await loginAgent(app, `dash-client-${tag}@flowx-test.com`, 'Test@123')
    const publisher = await createTestUser({ email: `dash-pub-${tag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    publisherId = publisher.id
    publisherToken = await loginAgent(app, `dash-pub-${tag}@flowx-test.com`, 'Test@123')
    adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
  })

  it('client dashboard returns real shape for fresh user', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/client').set('Authorization', `Bearer ${clientToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('campaigns')
    expect(res.body.data.campaigns).toHaveProperty('total')
    expect(res.body.data.campaigns).toHaveProperty('byStatus')
    expect(Array.isArray(res.body.data.campaigns.recent)).toBe(true)
    expect(res.body.data).toHaveProperty('posts')
    expect(res.body.data).toHaveProperty('wallet')
    expect(res.body.data.wallet).toHaveProperty('balance')
    expect(res.body.data).toHaveProperty('engagement')
    expect(res.body.data.engagement).toHaveProperty('daily')
  })

  it('publisher dashboard returns earnings + requests', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/publisher').set('Authorization', `Bearer ${publisherToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('earnings')
    expect(res.body.data.earnings).toHaveProperty('currentBalance')
    expect(res.body.data.earnings).toHaveProperty('lifetimeEarned')
    expect(res.body.data).toHaveProperty('requests')
    expect(res.body.data).toHaveProperty('accounts')
    expect(res.body.data).toHaveProperty('recentActivity')
  })

  it('admin dashboard returns overview', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/admin').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('overview')
    expect(res.body.data.overview).toHaveProperty('totalUsers')
    expect(res.body.data).toHaveProperty('campaigns')
    expect(res.body.data).toHaveProperty('posts')
  })

  it('rejects client dashboard for publisher role (403)', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/client').set('Authorization', `Bearer ${publisherToken}`)
    expect(res.status).toBe(403)
  })

  it('rejects unauthenticated (401)', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/client')
    expect(res.status).toBe(401)
  })

  it('rejects publisher dashboard for client', async () => {
    const res = await supertest(app).get('/api/v1/dashboard/publisher').set('Authorization', `Bearer ${clientToken}`)
    expect(res.status).toBe(403)
  })
})
