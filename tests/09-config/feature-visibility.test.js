import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import { queryOne } from '../../shared/database/connection.js'
import { loginAgent } from '../helpers/auth.js'
import { createTestUser } from '../helpers/create-user.js'
import { DEFAULT_FEATURE_VISIBILITY } from '../../src/modules/config/feature.controller.js'

let app
const dateTag = Date.now()

async function adminToken() {
  return loginAgent(app, 'admin@flowx.com', 'Admin@123')
}

describe('feature visibility admin endpoints', () => {
  beforeAll(async () => {
    const mod = await import('../../app.js')
    app = mod.default
  })

  it('should reject access for a non-super-admin user (403)', async () => {
    await createTestUser({
      email: `fv-client-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const token = await loginAgent(app, `fv-client-${dateTag}@flowx-test.com`, 'Test@123')
    const res = await supertest(app).get('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('should expose featureVisibility in the public config', async () => {
    const res = await supertest(app).get('/api/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveProperty('featureVisibility')
    expect(res.body.data.featureVisibility.client_campaigns).toBe(true)
  })

  it('should GET and PUT feature visibility as super admin', async () => {
    const token = await adminToken()
    const getRes = await supertest(app).get('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
    expect(getRes.status).toBe(200)
    expect(getRes.body.data.featureVisibility.client_campaigns).toBe(true)

    const putRes = await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'client_campaigns', visible: false })
    expect(putRes.status).toBe(200)
    expect(putRes.body.data.featureVisibility.client_campaigns).toBe(false)
    expect(putRes.body.data.featureVisibility.client_support).toBe(true)

    const getRes2 = await supertest(app).get('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
    expect(getRes2.body.data.featureVisibility.client_campaigns).toBe(false)

    await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'client_campaigns', visible: true })
  })

  it('should accept an unknown new feature key (extensible)', async () => {
    const token = await adminToken()
    const putRes = await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'client_new_feature', visible: false })
    expect(putRes.status).toBe(200)
    expect(putRes.body.data.featureVisibility.client_new_feature).toBe(false)

    const getRes = await supertest(app).get('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
    expect(getRes.body.data.featureVisibility.client_new_feature).toBe(false)

    await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'client_new_feature', visible: true })
  })

  it('should reject invalid payloads', async () => {
    const token = await adminToken()
    const noKey = await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ visible: true })
    expect(noKey.status).toBe(422)

    const notBoolean = await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'client_campaigns', visible: 'yes' })
    expect(notBoolean.status).toBe(422)

    const badKey = await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'UPPER_CASE', visible: true })
    expect(badKey.status).toBe(422)
  })

  it('should have sensible defaults and persist updates to app_config', async () => {
    expect(DEFAULT_FEATURE_VISIBILITY.client_campaigns).toBe(true)
    expect(DEFAULT_FEATURE_VISIBILITY.publisher_campaign_requests).toBe(true)
    expect(DEFAULT_FEATURE_VISIBILITY.client_image_generation).toBe(true)
    expect(DEFAULT_FEATURE_VISIBILITY.client_support).toBe(true)
    const token = await adminToken()
    await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'persisted_probe', visible: false })
    const row = await queryOne("SELECT config_value FROM app_config WHERE config_key = 'feature_visibility'")
    expect(row).toBeTruthy()
    const stored = JSON.parse(row.config_value)
    expect(stored.persisted_probe).toBe(false)
    await supertest(app).put('/api/v1/admin/config/features')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'persisted_probe', visible: true })
  })
})