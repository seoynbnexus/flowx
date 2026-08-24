import supertest from 'supertest'

export async function loginAgent(app, email, password) {
  const res = await supertest(app)
    .post('/api/v1/auth/login')
    .send({ email, password })
  if (!res.body.success) {
    throw new Error(`Login failed for ${email}: ${res.body.message}`)
  }
  return res.body.data.accessToken
}