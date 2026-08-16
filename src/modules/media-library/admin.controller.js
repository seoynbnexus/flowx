import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { sendSuccess, sendError } from '../../../shared/utils/response.utils.js'
import { HTTP_STATUS } from '../../../shared/constants/httpStatus.js'

async function readConfigKey(key) {
  const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [key])
  if (!row) return null
  try {
    return JSON.parse(row.config_value)
  } catch {
    return row.config_value
  }
}

async function writeConfigKey(key, value, adminId, description) {
  const existing = await queryOne('SELECT id FROM app_config WHERE config_key = ?', [key])
  if (existing) {
    await query(
      'UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = ?',
      [JSON.stringify(value), uuidToBuffer(adminId), key]
    )
  } else {
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
       VALUES (?, ?, ?, 1, ?, 1, ?)`,
      [uuidToBuffer(generateUuid()), key, JSON.stringify(value), description, uuidToBuffer(adminId)]
    )
  }
}

export async function getMediaConfig(req, res, next) {
  try {
    const [quotaBytes, maxFileBytes] = await Promise.all([
      readConfigKey('post_media_quota_bytes'),
      readConfigKey('post_media_max_file_bytes'),
    ])
    return sendSuccess(res, {
      quotaBytes: Number(quotaBytes) || 512 * 1024 * 1024,
      maxFileBytes: Number(maxFileBytes) || 200 * 1024 * 1024,
    })
  } catch (error) {
    next(error)
  }
}

export async function updateMediaConfig(req, res, next) {
  try {
    const { quotaBytes, maxFileBytes } = req.body

    if (quotaBytes !== undefined) {
      if (typeof quotaBytes !== 'number' || quotaBytes <= 0 || !Number.isInteger(quotaBytes)) {
        return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'quotaBytes must be a positive integer')
      }
      await writeConfigKey('post_media_quota_bytes', quotaBytes, req.user.id, 'Total media storage quota per user in bytes')
    }

    if (maxFileBytes !== undefined) {
      if (typeof maxFileBytes !== 'number' || maxFileBytes <= 0 || !Number.isInteger(maxFileBytes)) {
        return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'maxFileBytes must be a positive integer')
      }
      await writeConfigKey('post_media_max_file_bytes', maxFileBytes, req.user.id, 'Maximum size for a single uploaded media file in bytes')
    }

    const [newQuota, newMaxFile] = await Promise.all([
      readConfigKey('post_media_quota_bytes'),
      readConfigKey('post_media_max_file_bytes'),
    ])
    return sendSuccess(res, {
      quotaBytes: Number(newQuota) || 512 * 1024 * 1024,
      maxFileBytes: Number(newMaxFile) || 200 * 1024 * 1024,
    }, 'Media config updated')
  } catch (error) {
    next(error)
  }
}