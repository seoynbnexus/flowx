import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as categoryService from '../../src/modules/ad-categories/ad-category.service.js'

const dateTag = Date.now()

describe('ad category service', () => {
  let catId
  let testUser

  beforeAll(async () => {
    testUser = await createTestUser({
      email: `cat-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
  })

  it('should create a category', async () => {
    const cat = await categoryService.createCategory({
      code: `test_cat_${dateTag}`,
      name: 'Test Category',
      description: 'A test ad category',
    })
    expect(cat.code).toBe(`test_cat_${dateTag}`)
    catId = cat.id
  })

  it('should reject duplicate code', async () => {
    await expect(
      categoryService.createCategory({ code: `test_cat_${dateTag}`, name: 'Duplicate' })
    ).rejects.toThrow(/already exists/i)
  })

  it('should list categories', async () => {
    const cats = await categoryService.listCategories()
    expect(Array.isArray(cats)).toBe(true)
    expect(cats.some(c => c.id === catId)).toBe(true)
  })

  it('should get category by id', async () => {
    const cat = await categoryService.getCategory(catId)
    expect(cat.id).toBe(catId)
  })

  it('should throw on non-existent category', async () => {
    await expect(categoryService.getCategory(generateUuid())).rejects.toThrow(/not found/i)
  })

  it('should update a category', async () => {
    const updated = await categoryService.updateCategory(catId, { name: 'Updated Category' })
    expect(updated.name).toBe('Updated Category')
  })

  it('should set and get user categories', async () => {
    const allCats = await categoryService.listCategories()
    const ids = allCats.slice(0, 2).map(c => c.id)

    await categoryService.setMyCategories(testUser.id, ids)
    const myCats = await categoryService.getMyCategories(testUser.id)
    expect(myCats.length).toBe(ids.length)
  })

  it('should soft-delete a category', async () => {
    await categoryService.deleteCategory(catId)
    const cats = await categoryService.listCategories()
    expect(cats.some(c => c.id === catId)).toBe(false)
  })

  it('should include inactive when requested', async () => {
    const cats = await categoryService.listCategories(true)
    expect(cats.some(c => c.id === catId)).toBe(true)
  })
})
