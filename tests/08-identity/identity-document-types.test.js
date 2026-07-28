import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as docTypeService from '../../src/modules/identity-document-types/identity-document-types.service.js'

const dateTag = Date.now()

describe('identity document types', () => {
  let typeId

  it('should list document types', async () => {
    const types = await docTypeService.list()
    expect(Array.isArray(types)).toBe(true)
    expect(types.length).toBeGreaterThanOrEqual(2)
    expect(types.every(t => t.isActive)).toBe(true)
  })

  it('should include inactive when requested', async () => {
    const all = await docTypeService.list(true)
    const active = await docTypeService.list(false)
    expect(all.length).toBeGreaterThanOrEqual(active.length)
  })

  it('should create a document type', async () => {
    const type = await docTypeService.create({
      code: `test_doc_${dateTag}`,
      name: 'Test Document',
      description: 'A test document type',
      isMandatory: true,
    })
    expect(type.code).toBe(`test_doc_${dateTag}`)
    expect(type.isMandatory).toBe(true)
    typeId = type.id
  })

  it('should reject duplicate code', async () => {
    await expect(
      docTypeService.create({ code: `test_doc_${dateTag}`, name: 'Duplicate' })
    ).rejects.toThrow(/already exists/i)
  })

  it('should get by id', async () => {
    const type = await docTypeService.getById(typeId)
    expect(type.id).toBe(typeId)
  })

  it('should throw on non-existent', async () => {
    await expect(docTypeService.getById(generateUuid())).rejects.toThrow(/not found/i)
  })

  it('should update a document type', async () => {
    const updated = await docTypeService.update(typeId, { name: 'Updated Doc Type', isMandatory: false })
    expect(updated.name).toBe('Updated Doc Type')
    expect(updated.isMandatory).toBe(false)
  })

  it('should soft-delete a document type', async () => {
    await docTypeService.remove(typeId)
    const all = await docTypeService.list(false)
    expect(all.some(t => t.id === typeId)).toBe(false)
  })
})
