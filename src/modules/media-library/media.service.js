import * as repo from './media.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../../shared/errors/AppError.js'
import { mediaKindForMime, MAX_MEDIA_FILE_BYTES, MEDIA_UPLOAD_DIR } from '../../../shared/utils/post-media-upload.js'
import { MEDIA_DEFAULT_QUOTA_BYTES } from './media.model.js'
import { queryOne } from '../../../shared/database/connection.js'
import fs from 'fs/promises'
import path from 'path'

export function getMediaQuotaBytes() {
  const configured = Number(process.env.POST_MEDIA_QUOTA_BYTES)
  if (Number.isFinite(configured) && configured > 0) return configured
  return MEDIA_DEFAULT_QUOTA_BYTES
}

export async function getPerUserQuota(userId) {
  const row = await queryOne(
    "SELECT config_value FROM app_config WHERE config_key = 'post_media_quota_bytes' AND is_public = 1"
  )
  if (row) {
    try {
      const value = JSON.parse(row.config_value)
      if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value)
    } catch {
      // fall through to env/default
    }
  }
  return getMediaQuotaBytes()
}

export async function getMaxFileBytes() {
  const row = await queryOne(
    "SELECT config_value FROM app_config WHERE config_key = 'post_media_max_file_bytes' AND is_public = 1"
  )
  if (row) {
    try {
      const value = JSON.parse(row.config_value)
      if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value)
    } catch {
      // fall through to env/default
    }
  }
  return MAX_MEDIA_FILE_BYTES
}

export function mediaUrlFor(storagePath) {
  if (!storagePath) return storagePath
  if (/^https?:\/\//.test(storagePath)) return storagePath
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  if (base) return `${base}${storagePath}`
  return storagePath
}

export async function uploadMedia(userId, file, { name } = {}) {
  if (!file) {
    throw new ValidationError('File not provided')
  }
  const kind = mediaKindForMime(file.mimetype)
  if (!kind) {
    throw new ValidationError(`Invalid media type: ${file.mimetype}`)
  }
  const fileSize = Number(file.size)
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    throw new ValidationError('Uploaded file is empty')
  }
  if (fileSize > MAX_MEDIA_FILE_BYTES) {
    const maxFileBytes = await getMaxFileBytes()
    if (fileSize > maxFileBytes) {
      throw new ValidationError(`File exceeds the ${Math.round(maxFileBytes / (1024 * 1024))} MB per-file limit`)
    }
  }

  const quotaBytes = await getPerUserQuota(userId)
  const usedBytes = await repo.sumUserMediaBytes(userId)
  if (usedBytes + fileSize > quotaBytes) {
    const usedMb = (usedBytes / (1024 * 1024)).toFixed(1)
    const quotaMb = (quotaBytes / (1024 * 1024)).toFixed(1)
    throw new ValidationError(`Media quota exceeded (${usedMb} MB used of ${quotaMb} MB)`)
  }

  const storagePath = `/uploads/posts/${file.filename}`
  const asset = await repo.createMediaAsset(generateUuid(), userId, {
    name: name?.trim() || file.originalname || file.filename,
    storagePath,
    mimeType: file.mimetype,
    mediaKind: kind,
    sizeBytes: fileSize,
  })
  return {
    ...asset,
    url: mediaUrlFor(storagePath),
  }
}

export async function listMedia(userId, { page = 1, limit = 20, kind }) {
  const result = await repo.findMediaByUserId(userId, { page, limit, kind })
  const [totalBytes, quotaBytes] = await Promise.all([
    repo.sumUserMediaBytes(userId),
    getPerUserQuota(userId),
  ])
  return {
    ...result,
    items: result.items.map(asset => ({
      ...asset,
      url: mediaUrlFor(asset.storagePath),
    })),
    totalBytes,
    quotaBytes,
  }
}

export async function deleteMedia(userId, id) {
  const asset = await repo.findMediaAssetById(id)
  if (!asset) {
    throw new NotFoundError('Media asset not found')
  }
  if (asset.userId !== userId) {
    throw new ForbiddenError('You can only delete your own media')
  }

  const url = mediaUrlFor(asset.storagePath)
  const referencing = await repo.countPostsReferencingMedia(url, asset.storagePath)
  if (referencing > 0) {
    throw new ConflictError('This media is referenced by a post and cannot be deleted')
  }

  await repo.deleteMediaAsset(id)
  const resolved = path.join(MEDIA_UPLOAD_DIR, path.basename(asset.storagePath))
  await fs.unlink(resolved).catch(() => {})
  return { id }
}