import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

dotenv.config()

const USER_HEX_ID = '0x019f8958f86f75338b01c8355fde7595'
const FB_PAGE_ID = '977503895454587'
const IG_ACTOR_ID = ''
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID
const SYSTEM_TOKEN = process.env.META_SYSTEM_USER_TOKEN
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
const GRAPH_VERSION = 'v22.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

const TS = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
const LOG_FILE = path.resolve('logs', `test-meta-ad-creation-${TS}.log`)

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })

function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(msg.padEnd(120))
  fs.appendFileSync(LOG_FILE, msg + '\n')
}

function maskToken(t) {
  if (!t || t.length < 12) return t
  return t.substring(0, 10) + '...' + t.substring(t.length - 4)
}

function logRequest(step, method, url, body) {
  const lines = [
    `\n--- ${step} Request ---`,
    `${method} ${url}`,
  ]
  if (body) {
    const sanitized = { ...body }
    Object.keys(sanitized).forEach(k => {
      if (k.includes('token') || k.includes('access')) sanitized[k] = maskToken(sanitized[k])
    })
    lines.push(`Body: ${JSON.stringify(sanitized, null, 2)}`)
  }
  fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n')
  console.log(`    → ${method} ${url.split('?')[0]}`)
}

function logResponse(step, status, data) {
  const msg = `--- ${step} Response ---\nStatus: ${status}\nBody: ${JSON.stringify(data, null, 2)}`
  fs.appendFileSync(LOG_FILE, msg + '\n')
}

function logSection(title) {
  const msg = `\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}`
  log(msg)
}

function decrypt(encryptedText) {
  if (!encryptedText) return null
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters')
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex')
  const parts = encryptedText.split(':')
  const iv = Buffer.from(parts.shift(), 'hex')
  const encrypted = parts.join(':')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

async function apiPost(step, endpoint, params, token) {
  const url = `${GRAPH_BASE}/${endpoint}`
  logRequest(step, 'POST', url, { ...params, access_token: token })
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  }
  body.append('access_token', token)
  const res = await fetch(url, { method: 'POST', body })
  const data = await res.json()
  logResponse(step, res.status, data)
  return { ok: res.status >= 200 && res.status < 300 && !data.error, status: res.status, data }
}

async function apiGet(step, endpoint, params, token) {
  const url = new URL(`${GRAPH_BASE}/${endpoint}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v))
  }
  url.searchParams.append('access_token', token)
  logRequest(step, 'GET', url.toString(), null)
  const res = await fetch(url.toString())
  const data = await res.json()
  logResponse(step, res.status, data)
  return { ok: res.status >= 200 && res.status < 300 && !data.error, status: res.status, data }
}

function record(results, step, label, passed, detail) {
  const icon = passed ? '  ✓' : '  ✗'
  log(`${icon} [${step}] ${label}: ${detail}`)
  results.push({ step, label, passed, detail })
}

async function main() {
  logSection('META AD CREATION DIAGNOSTIC — v3')
  log(`Started: ${new Date().toISOString()}`)
  log(`Log file: ${LOG_FILE}`)
  log(`User: ${USER_HEX_ID}`)
  log(`FB Page ID: ${FB_PAGE_ID}`)
  log(`IG Actor ID: ${IG_ACTOR_ID}`)
  log(`Ad Account ID: ${AD_ACCOUNT_ID}`)
  log(`API Version: ${GRAPH_VERSION}`)

  const results = []

  if (!SYSTEM_TOKEN) { log('FATAL: META_SYSTEM_USER_TOKEN not set in .env'); process.exit(1) }
  if (!AD_ACCOUNT_ID) { log('FATAL: META_AD_ACCOUNT_ID not set in .env'); process.exit(1) }
  if (!ENCRYPTION_KEY) { log('FATAL: ENCRYPTION_KEY not set in .env'); process.exit(1) }

  const SUFFIX = String(Date.now()).slice(-8)

  // ========== Step 0: DB ==========
  logSection('Step 0: Database — Fetch credentials')
  let pageToken, userAccessToken, igToken
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'flowx',
      waitForConnections: true, connectionLimit: 1,
    })

    const buf = Buffer.from(USER_HEX_ID.replace('0x', ''), 'hex')

    const [pages] = await pool.execute(
      `SELECT * FROM user_platform_accounts WHERE user_id = ? AND platform_user_id = ? AND token_type = 'page'`,
      [buf, FB_PAGE_ID]
    )
    if (pages.length === 0) {
      record(results, '0', 'DB fetch', false, `No page record for ${FB_PAGE_ID}`)
      await pool.end()
      printSummary(results); return
    }
    const p = pages[0]
    pageToken = decrypt(p.access_token)
    log(`  Page: ${p.platform_display_name} (${p.platform_user_id})`)
    log(`  Verification status: ${p.verification_status}`)
    log(`  Token status: ${p.token_status}, expires: ${p.token_expires_at}`)
    log(`  Page token decrypted: ${pageToken ? 'YES' : 'NO'}`)

    const [userTokens] = await pool.execute(
      `SELECT * FROM user_platform_accounts WHERE user_id = ? AND token_type = 'user' AND platform_id = (SELECT id FROM platforms WHERE code = 'facebook' LIMIT 1)`,
      [buf]
    )
    if (userTokens.length > 0) {
      userAccessToken = decrypt(userTokens[0].access_token)
      log(`  User token decrypted: ${userAccessToken ? 'YES' : 'NO'}`)
      log(`  FB User ID: ${userTokens[0].platform_user_id}`)
    } else {
      log(`  No user-level token found — Step 5 may fail`)
    }

    const [igs] = await pool.execute(
      `SELECT * FROM user_platform_accounts WHERE user_id = ? AND platform_user_id = ?`,
      [buf, IG_ACTOR_ID]
    )
    if (igs.length > 0) {
      igToken = decrypt(igs[0].access_token)
      log(`  IG token decrypted: ${igToken ? 'YES' : 'NO'}`)
    } else {
      log(`  No IG account record found for ${IG_ACTOR_ID}`)
    }

    await pool.end()
    record(results, '0', 'DB fetch', true, `Page: ${p.platform_display_name}, token OK`)
  } catch (err) {
    record(results, '0', 'DB fetch', false, err.message)
    printSummary(results)
    return
  }

  if (!pageToken) {
    record(results, '0', 'Page token', false, 'Failed to decrypt page token')
    printSummary(results)
    return
  }

  // ========== Step 1: Verify system token ==========
  logSection('Step 1: Verify system token (get system user ID)')
  let sysUserId
  {
    const r = await apiGet('1', 'me', { fields: 'id,name' }, SYSTEM_TOKEN)
    if (r.ok) {
      sysUserId = r.data.id
      record(results, '1', 'System token', true, `User: ${r.data.name} (${sysUserId})`)
    } else {
      record(results, '1', 'System token', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 2a: Check user token permissions ==========
  logSection('Step 2a: Check user token permissions')
  if (userAccessToken) {
    const r = await apiGet('2a', 'me/permissions', {}, userAccessToken)
    if (r.ok) {
      const perms = r.data.data || []
      const meta = perms.find(p => p.permission === 'pages_manage_metadata')
      if (meta) {
        record(results, '2a', 'pages_manage_metadata', meta.status === 'granted', `${meta.permission} = ${meta.status}`)
      } else {
        record(results, '2a', 'pages_manage_metadata', false, 'NOT FOUND in user token permissions')
      }
      const ads = perms.find(p => p.permission === 'pages_manage_ads')
      log(`  pages_manage_ads: ${ads ? ads.status : 'NOT FOUND'}`)
      log(`  Token has ${perms.length} permissions`)
    } else {
      record(results, '2a', 'Check permissions', false, r.data.error?.message || 'Unknown')
    }
  } else {
    record(results, '2a', 'Check permissions', false, 'No user token available')
  }

  // ========== Step 2b: Verify page token ==========
  logSection('Step 2b: Verify page token')
  {
    const r = await apiGet('2b', 'me', { fields: 'id,name' }, pageToken)
    if (r.ok) {
      record(results, '2b', 'Page token', true, `${r.data.name} (${r.data.id})`)
    } else {
      record(results, '2b', 'Page token', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 3: Check IG linkage ==========
  logSection('Step 3: Check Facebook Page → Instagram linkage')
  let igLinkedId = null
  {
    const r = await apiGet('3', FB_PAGE_ID, {
      fields: 'name,instagram_business_account{id,username,name}'
    }, pageToken)
    if (r.ok) {
      const igBiz = r.data.instagram_business_account
      if (igBiz) {
        igLinkedId = igBiz.id
        log(`  Instagram Business Account linked: ${igBiz.id} (${igBiz.username})`)
      } else {
        log(`  No Instagram Business Account linked to this page`)
      }
      record(results, '3', 'IG linkage', true, igLinkedId ? `IG: ${igLinkedId}` : 'No IG linked')
    } else {
      record(results, '3', 'IG linkage', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 4: Create Campaign ==========
  logSection('Step 4: Create Campaign (PAUSED)')
  let campaignId = null
  {
    const campaignName = `FlowX-DIAG-${SUFFIX}`
    const r = await apiPost('4', `act_${AD_ACCOUNT_ID}/campaigns`, {
      name: campaignName,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    }, SYSTEM_TOKEN)
    if (r.ok) {
      campaignId = r.data.id
      record(results, '4', 'Create Campaign', true, `id: ${campaignId}`)
    } else {
      record(results, '4', 'Create Campaign', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 5: Check page access ==========
  logSection('Step 5: Check system user page access')
  {
    const r = await apiGet('5', FB_PAGE_ID, { fields: 'id,name' }, SYSTEM_TOKEN)
    if (r.ok) {
      record(results, '5', 'System user page access', true, `System user can read page: ${r.data.name}`)
    } else {
      const msg = r.data.error?.message || 'Unknown'
      record(results, '5', 'System user page access', false, msg)
      log(`\n  ⚠️  System user ${sysUserId} cannot access page ${FB_PAGE_ID}.`)
      log(`  To fix: Go to https://business.facebook.com/settings/people`)
      log(`  → System Users → ${sysUserId} → Assets → Pages`)
      log(`  → Add "Wish Academy" with "Advertise" access\n`)
    }
  }

  // ========== Step 6: Create AdSet ==========
  logSection('Step 6: Create AdSet (PAUSED) — daily budget ₹100')
  let adSetId = null
  if (campaignId) {
    const targeting = {
      geo_locations: { countries: ['IN'] },
      targeting_automation: { advantage_audience: 0 },
    }
    const r = await apiPost('6', `act_${AD_ACCOUNT_ID}/adsets`, {
      name: `FlowX-DIAG-AdSet-${SUFFIX}`,
      campaign_id: campaignId,
      daily_budget: 10000,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'REACH',
      targeting,
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
      status: 'PAUSED',
    }, SYSTEM_TOKEN)
    if (r.ok) {
      adSetId = r.data.id
      record(results, '6', 'Create AdSet', true, `id: ${adSetId}`)
    } else {
      record(results, '6', 'Create AdSet', false, r.data.error?.message || 'Unknown')
    }
  } else {
    record(results, '6', 'Create AdSet', false, 'Skipped — no campaign ID')
  }

  // ========== Step 7a: Create Creative A (system token, no IG) ==========
  logSection('Step 7a: Create Creative A — system token, no instagram_actor_id')
  let creativeAId = null
  {
    const r = await apiPost('7a', `act_${AD_ACCOUNT_ID}/adcreatives`, {
      name: `FlowX-DIAG-Creative-A-${SUFFIX}`,
      object_story_spec: {
        page_id: FB_PAGE_ID,
        link_data: {
          link: 'https://example.com/diag-a',
          message: 'FlowX diagnostic — Creative A (system token, no IG)',
        },
      },
    }, SYSTEM_TOKEN)
    if (r.ok) {
      creativeAId = r.data.id
      record(results, '7a', 'Creative A (no IG)', true, `id: ${creativeAId}`)
    } else {
      record(results, '7a', 'Creative A (no IG)', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 7b: Create Creative B (system token, with IG) ==========
  logSection('Step 7b: Create Creative B — system token + instagram_actor_id')
  let creativeBId = null
  {
    const creativeBParams = {
      name: `FlowX-DIAG-Creative-B-${SUFFIX}`,
      object_story_spec: {
        page_id: FB_PAGE_ID,
        link_data: {
          link: 'https://example.com/diag-b',
          message: 'FlowX diagnostic — Creative B (system token + IG)',
        },
      },
    }
    const igIdToUse = igLinkedId || IG_ACTOR_ID
    if (igIdToUse) {
      creativeBParams.instagram_actor_id = igIdToUse
    }
    const r = await apiPost('7b', `act_${AD_ACCOUNT_ID}/adcreatives`, creativeBParams, SYSTEM_TOKEN)
    if (r.ok) {
      creativeBId = r.data.id
      record(results, '7b', 'Creative B (with IG)', true, `id: ${creativeBId}`)
    } else {
      record(results, '7b', 'Creative B (with IG)', false, r.data.error?.message || 'Unknown')
    }
  }

  // ========== Step 8a: Create Ad A ==========
  logSection('Step 8a: Create Ad A (PAUSED) — referencing Creative A')
  if (adSetId && creativeAId) {
    const r = await apiPost('8a', `act_${AD_ACCOUNT_ID}/ads`, {
      name: `FlowX-DIAG-Ad-A-${SUFFIX}`,
      adset_id: adSetId,
      creative: { creative_id: creativeAId },
      status: 'PAUSED',
    }, SYSTEM_TOKEN)
    if (r.ok) {
      record(results, '8a', 'Ad A (creative A)', true, `id: ${r.data.id}`)
    } else {
      record(results, '8a', 'Ad A (creative A)', false, r.data.error?.message || 'Unknown')
    }
  } else {
    record(results, '8a', 'Ad A (creative A)', false, !adSetId ? 'No ad set ID' : 'No creative A ID')
  }

  // ========== Step 8b: Create Ad B ==========
  logSection('Step 8b: Create Ad B (PAUSED) — referencing Creative B')
  if (adSetId && creativeBId) {
    const r = await apiPost('8b', `act_${AD_ACCOUNT_ID}/ads`, {
      name: `FlowX-DIAG-Ad-B-${SUFFIX}`,
      adset_id: adSetId,
      creative: { creative_id: creativeBId },
      status: 'PAUSED',
    }, SYSTEM_TOKEN)
    if (r.ok) {
      record(results, '8b', 'Ad B (creative B)', true, `id: ${r.data.id}`)
    } else {
      record(results, '8b', 'Ad B (creative B)', false, r.data.error?.message || 'Unknown')
    }
  } else {
    record(results, '8b', 'Ad B (creative B)', false, !adSetId ? 'No ad set ID' : 'No creative B ID')
  }

  // ========== Summary ==========
  printSummary(results)
}

function printSummary(results) {
  logSection('SUMMARY')
  const passed = results.filter(r => r.passed).length
  const total = results.length
  log(`\n  ${passed}/${total} steps passed\n`)
  results.forEach(r => {
    const icon = r.passed ? '  ✓' : '  ✗'
    log(`${icon} [${r.step}] ${r.label}: ${r.detail}`)
  })
  log(`\nLog saved to: ${LOG_FILE}`)
}

main().catch(err => {
  log(`\nFATAL: ${err.stack || err.message}`)
  process.exit(1)
})
