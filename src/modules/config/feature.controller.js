import { query, queryOne, transaction } from '../../../shared/database/connection.js'
import { uuidToBuffer, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { sendSuccess, sendError } from '../../../shared/utils/response.utils.js'
import { HTTP_STATUS } from '../../../shared/constants/httpStatus.js'
import fs from 'fs'

const FEATURE_VISIBILITY_KEY = 'feature_visibility'

export const DEFAULT_FEATURE_VISIBILITY = {
  client_campaigns: true,
  publisher_campaign_requests: true,
  client_image_generation: true,
  client_support: true,
  campaign_duplicate: false,
  post_duplicate: false,
  publisher_registration: true,
}

async function readFeatureVisibility() {
  const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [FEATURE_VISIBILITY_KEY])

    fs.appendFileSync(
    './logs/feature_visibility.log',
    `[GET] row=${JSON.stringify(row)} pid=${process.pid} time=${new Date().toISOString()}\n`
  )


  if (!row) return null
  try {
       const parsed = JSON.parse(row.config_value)

    fs.appendFileSync(
      './logs/feature_visibility.log',
      `[GET] parsed=${JSON.stringify(parsed)} pid=${process.pid} time=${new Date().toISOString()}\n`
    )

    return parsed
  } catch {
    return null
  }
}

async function writeFeatureVisibility(value, adminId) {
  const existing = await queryOne('SELECT id FROM app_config WHERE config_key = ?', [FEATURE_VISIBILITY_KEY])
  if (existing) {
    await query(
      'UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = ?',
      [JSON.stringify(value), uuidToBuffer(adminId), FEATURE_VISIBILITY_KEY]
    )
  } else {
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
       VALUES (?, ?, ?, 1, ?, 1, ?)`,
      [uuidToBuffer(generateUuid()), FEATURE_VISIBILITY_KEY, JSON.stringify(value),
        'Feature visibility toggles per role (true = visible)', uuidToBuffer(adminId)]
    )
  }
}

export async function getFeatureVisibility(req, res, next) {
  try {
    const stored = await readFeatureVisibility()
    //for logging
    const featureVisibility = {
      ...DEFAULT_FEATURE_VISIBILITY,
      ...(stored || {}),
    }

    fs.appendFileSync(
      './logs/feature_visibility.log',
      `[GET] response=${JSON.stringify(featureVisibility)} pid=${process.pid} time=${new Date().toISOString()}\n`
    )
    return sendSuccess(res, { featureVisibility: { ...DEFAULT_FEATURE_VISIBILITY, ...(stored || {}) } })
  } catch (error) {
    next(error)
  }
}

export async function updateFeatureVisibility(req, res, next) {
  try {
    const { key, visible } = req.body
    if (!key || typeof key !== 'string' || !key.trim()) {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'feature key is required')
    }
    if (typeof visible !== 'boolean') {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'visible must be a boolean')
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'invalid feature key')
    }

    const persisted = await transaction(async (conn) => {
      const [rows] = await conn.execute('SELECT config_value FROM app_config WHERE config_key = ? FOR UPDATE', [FEATURE_VISIBILITY_KEY])
      const storedRow = rows[0]
      
      // log
      fs.appendFileSync('./logs/feature_visibility.log', `Admin req select query for config_key ${FEATURE_VISIBILITY_KEY}, storedRow: ${JSON.stringify(storedRow)} , timestamp: ${new Date().toISOString()}\n`)

      let stored = null
      if (storedRow) {
        try {
          stored = JSON.parse(storedRow.config_value)
        } catch {
          stored = null
        }
      }
      const base = { ...DEFAULT_FEATURE_VISIBILITY, ...(stored || {}) }
      const nextMap = { ...base, [key]: visible }

      const [existing] = await conn.execute('SELECT id FROM app_config WHERE config_key = ?', [FEATURE_VISIBILITY_KEY])
      
      // log
      fs.appendFileSync('./logs/feature_visibility.log', `Admin req select query for config_key ${FEATURE_VISIBILITY_KEY}, existing: ${JSON.stringify(existing)} , timestamp: ${new Date().toISOString()}\n`)
      
      if (existing.length > 0) {
        await conn.execute(
          'UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = ?',
          [JSON.stringify(nextMap), uuidToBuffer(req.user.id), FEATURE_VISIBILITY_KEY]
        )
        fs.appendFileSync('./logs/feature_visibility.log', `Admin req update query for config_key ${FEATURE_VISIBILITY_KEY}, nextMap: ${JSON.stringify(nextMap)} , timestamp: ${new Date().toISOString()}\n`)
      } else {
        await conn.execute(
          `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
           VALUES (?, ?, ?, 1, ?, 1, ?)`,
          [uuidToBuffer(generateUuid()), FEATURE_VISIBILITY_KEY, JSON.stringify(nextMap),
            'Feature visibility toggles per role (true = visible)', uuidToBuffer(req.user.id)]
        )
      }

      const [freshRows] = await conn.execute('SELECT config_value FROM app_config WHERE config_key = ?', [FEATURE_VISIBILITY_KEY])
      const freshRow = freshRows[0]
      if (!freshRow) return nextMap
      try {
        const fresh = JSON.parse(freshRow.config_value)

        // log
        fs.appendFileSync('./logs/feature_visibility.log', `Admin req select query for config_key ${FEATURE_VISIBILITY_KEY}, fresh: ${JSON.stringify(fresh)} , timestamp: ${new Date().toISOString()}\n`)
        fs.appendFileSync('./logs/feature_visibility.log', `func persisted returning: ${JSON.stringify({ ...DEFAULT_FEATURE_VISIBILITY, ...(fresh || {}) })} , timestamp: ${new Date().toISOString()}\n`)
        return { ...DEFAULT_FEATURE_VISIBILITY, ...(fresh || {}) }
      } catch {
        fs.appendFileSync('./logs/feature_visibility.log', `func persisted returning: ${JSON.stringify(nextMap)} , timestamp: ${new Date().toISOString()}\n`)
        return nextMap
      }
    })
    // log
    fs.appendFileSync('./logs/feature_visibility.log', `Admin req updateFeatureVisibility returning: ${JSON.stringify({ featureVisibility: persisted })} , timestamp: ${new Date().toISOString()}\n`)
    
    return sendSuccess(res, { featureVisibility: persisted }, 'Feature visibility updated')
  } catch (error) {
    //log
    fs.appendFileSync('./logs/feature_visibility.log', `Admin req updateFeatureVisibility error: ${error.message} , timestamp: ${new Date().toISOString()}\n`)
    
    next(error)
  }
}

const PUBLISHER_MAX_KEY = 'publisher_max_accounts_per_request'

async function readPublisherMax() {
  const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [PUBLISHER_MAX_KEY])
  if (!row) return 5
  try {
    const v = JSON.parse(row.config_value)
    const n = Number(v)
    if (!Number.isFinite(n) || n < 1 || n > 10) return 5
    return Math.floor(n)
  } catch { return 5 }
}

async function writePublisherMax(value, adminId) {
  const existing = await queryOne('SELECT id FROM app_config WHERE config_key = ?', [PUBLISHER_MAX_KEY])
  if (existing) {
    await query('UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = ?', [JSON.stringify(value), uuidToBuffer(adminId), PUBLISHER_MAX_KEY])
  } else {
    await query(`INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by) VALUES (?, ?, ?, 1, ?, 1, ?)`,
      [uuidToBuffer(generateUuid()), PUBLISHER_MAX_KEY, JSON.stringify(value), 'Max verified accounts a publisher may select per post request (1..10)', uuidToBuffer(adminId)])
  }
}

export async function getPublisherMaxAccounts(req, res, next) {
  try {
    const max = await readPublisherMax()
    return sendSuccess(res, { max })
  } catch (error) { next(error) }
}

export async function updatePublisherMaxAccounts(req, res, next) {
  try {
    const { max } = req.body
    await writePublisherMax(max, req.user.id)
    return sendSuccess(res, { max }, 'Publisher max accounts updated')
  } catch (error) { next(error) }
}

export async function getPublisherDeadline(req, res, next) {
  try {
    const hoursRow = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['publisher_response_deadline_hours'])
    let hours = 48
    if (hoursRow) {
      try {
        const v = JSON.parse(hoursRow.config_value)
        const n = Number(v)
        if (Number.isFinite(n) && n >= 1 && n <= 720) hours = Math.floor(n)
      } catch {}
    } else if (process.env.POST_PUBLISHER_DEADLINE_HOURS) {
      const n = Number(process.env.POST_PUBLISHER_DEADLINE_HOURS)
      if (Number.isFinite(n) && n >= 1 && n <= 720) hours = Math.floor(n)
    } else {
      const daysRow = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['publisher_response_deadline_days'])
      if (daysRow) {
        try {
          const v = JSON.parse(daysRow.config_value)
          const n = Number(v)
          if (Number.isFinite(n) && n >= 1) hours = Math.floor(n * 24)
        } catch {}
      }
    }
    return sendSuccess(res, { hours })
  } catch (error) { next(error) }
}

export async function updatePublisherDeadline(req, res, next) {
  try {
    const { hours } = req.body
    const n = Number(hours)
    if (!Number.isFinite(n) || n < 1 || n > 720) return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'hours must be 1..720')
    const existing = await queryOne('SELECT id FROM app_config WHERE config_key = ?', ['publisher_response_deadline_hours'])
    if (existing) {
      await query('UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = ?', [JSON.stringify(Math.floor(n)), uuidToBuffer(req.user.id), 'publisher_response_deadline_hours'])
    } else {
      await query(`INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by) VALUES (?, ?, ?, 1, ?, 1, ?)`,
        [uuidToBuffer(generateUuid()), 'publisher_response_deadline_hours', JSON.stringify(Math.floor(n)), 'General waiting time for publishers to accept (hours, 1..720)', uuidToBuffer(req.user.id)])
    }
    return sendSuccess(res, { hours: Math.floor(n) }, 'Publisher deadline updated')
  } catch (error) { next(error) }
}