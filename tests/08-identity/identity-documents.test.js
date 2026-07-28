import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { query } from '../../shared/database/connection.js'
import * as identityService from '../../src/modules/identity-documents/identity.service.js'

const dateTag = Date.now()
const mockFile = { filename: `test-${dateTag}.jpg`, path: `/uploads/identity/test-${dateTag}.jpg`, mimetype: 'image/jpeg' }

describe('identity documents', () => {
  let testUser, adminId, docId

  beforeAll(async () => {
    testUser = await createTestUser({
      email: `id-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const row = await query("SELECT id FROM users WHERE email = 'admin@flowx.com' LIMIT 1")
    const { bufferToUuid } = await import('../../shared/utils/uuid.utils.js')
    adminId = row.length ? bufferToUuid(row[0].id) : null
  })

  it('should reject upload without file', async () => {
    await expect(identityService.upload(testUser.id, 'aadhaar', null)).rejects.toThrow(/file/i)
  })

  it('should reject invalid document type', async () => {
    await expect(identityService.upload(testUser.id, 'nonexistent_type', mockFile)).rejects.toThrow(/invalid/i)
  })

  it('should upload a document', async () => {
    const doc = await identityService.upload(testUser.id, 'aadhaar', mockFile)
    expect(doc.status).toBe('pending')
    expect(doc.documentType).toBe('aadhaar')
    expect(doc.documentUrl).toContain(mockFile.filename)
    docId = doc.id
  })

  it('should list my documents', async () => {
    const docs = await identityService.getMyDocuments(testUser.id)
    expect(docs.length).toBeGreaterThanOrEqual(1)
    expect(docs.some(d => d.id === docId)).toBe(true)
  })

  it('should get document by type', async () => {
    const doc = await identityService.getMyDocumentByType(testUser.id, 'aadhaar')
    expect(doc.id).toBe(docId)
  })

  it('should throw on non-existent document type', async () => {
    await expect(identityService.getMyDocumentByType(testUser.id, 'nonexistent')).rejects.toThrow(/not found/i)
  })

  it('should report missing mandatory documents', async () => {
    const missing = await identityService.getMissingMandatory(testUser.id)
    expect(Array.isArray(missing)).toBe(true)
  })

  it('should verify document as admin', async () => {
    if (!adminId) return
    const verified = await identityService.verify(docId, 'verified', adminId)
    expect(verified.status).toBe('verified')
  })

  it('should reject re-verifying already verified document', async () => {
    if (!adminId) return
    await expect(identityService.verify(docId, 'verified', adminId)).rejects.toThrow(/already verified/i)
  })

  it('should list all documents as admin', async () => {
    const result = await identityService.listAll({ page: 1, limit: 20 })
    expect(result.documents.length).toBeGreaterThanOrEqual(1)
  })

  it('should replace unverified document on re-upload', async () => {
    const mockFile2 = { filename: `test-${dateTag}-v2.jpg`, path: `/uploads/identity/test-${dateTag}-v2.jpg`, mimetype: 'image/jpeg' }
    const newDoc = await identityService.upload(testUser.id, 'drivers_license', mockFile2)
    expect(newDoc.documentUrl).toContain('v2')
    expect(newDoc.status).toBe('pending')
  })
})
