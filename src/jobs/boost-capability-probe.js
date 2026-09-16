import dotenv from 'dotenv'
dotenv.config()

import { writeFileSync } from 'node:fs'
import { closePool } from '../../shared/database/connection.js'
import { META_CONFIG } from '../../shared/services/meta-oauth.config.js'
import {
  createAdCampaign,
  createAdSet,
  createAdCreativeFromPost,
  deleteAdCampaign,
  extractMetaError,
} from '../../shared/services/meta-ads.service.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const AD_ACCOUNT_ID = META_CONFIG.adAccountId
const TOKEN = META_CONFIG.systemUserToken
const PAGE_ID = '977503895454587'
const FB_POST_OBJECT = '977503895454587_122122864244927287'
const FB_STORY_OBJECT = '122121854420927287'

const baseTargeting = { geo_locations: { countries: ['IN'] }, age_min: 18, age_max: 65, genders: [1, 2] }
const baseBudget = { budgetType: 'daily', budgetAmount: 300, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', destinationType: 'ON_POST' }

const EXPERIMENTS = [
  { id: 'E1', question: 'sanity: FB post adset, [facebook,instagram], REACH', placement: { publisher_platforms: ['facebook', 'instagram'] }, goal: 'REACH', promotedPageId: PAGE_ID, expect: 'pass' },
  { id: 'E2', question: 'IG media adset with facebook platform — is the IG lock required?', placement: { publisher_platforms: ['facebook', 'instagram'] }, goal: 'REACH', promotedPageId: null, expect: 'fail' },
  { id: 'E3', question: 'IG media adset, instagram-only — current behavior valid?', placement: { publisher_platforms: ['instagram'] }, goal: 'REACH', promotedPageId: null, expect: 'pass' },
  { id: 'E4', question: 'THRUPLAY goal + ON_POST (video/reel context)', placement: { publisher_platforms: ['facebook', 'instagram'] }, goal: 'THRUPLAY', promotedPageId: PAGE_ID, expect: 'unknown' },
  { id: 'E5', question: 'THRUPLAY goal + ON_POST (photo-post context)', placement: { publisher_platforms: ['facebook'] }, goal: 'THRUPLAY', promotedPageId: PAGE_ID, expect: 'unknown' },
  { id: 'E7', question: 'messenger_positions [messenger_home] on FB post', placement: { publisher_platforms: ['facebook', 'messenger'], messenger_positions: ['messenger_home'] }, goal: 'REACH', promotedPageId: PAGE_ID, expect: 'unknown' },
  { id: 'E8', question: 'audience_network_positions [classic] on FB post', placement: { publisher_platforms: ['facebook', 'audience_network'], audience_network_positions: ['classic'] }, goal: 'REACH', promotedPageId: PAGE_ID, expect: 'unknown' },
  { id: 'E9', question: 'IMPRESSIONS goal + ON_POST — is the v20 deprecation enforced?', placement: { publisher_platforms: ['facebook', 'instagram'] }, goal: 'IMPRESSIONS', promotedPageId: PAGE_ID, expect: 'fail' },
]

async function runAdsetExperiment(campaignId, exp) {
  const budget = { ...baseBudget, optimizationGoal: exp.goal, promotedPageId: exp.promotedPageId }
  try {
    await createAdSet(AD_ACCOUNT_ID, campaignId, { ...baseTargeting }, budget, {}, exp.placement, TOKEN, true, 'ON_POST')
    return { pass: true, error: null }
  } catch (err) {
    return { pass: false, error: extractMetaError(err) }
  }
}

async function main() {
  if (!AD_ACCOUNT_ID || !TOKEN) {
    console.error('probe requires META_AD_ACCOUNT_ID + META_SYSTEM_USER_TOKEN')
    process.exit(1)
  }
  const results = []
  let campaignId = null
  try {
    const campaign = await createAdCampaign(AD_ACCOUNT_ID, `FlowX-Probe-${Date.now()}`, 'OUTCOME_ENGAGEMENT', 'PAUSED', TOKEN)
    campaignId = campaign.id
    console.log(`probe campaign ${campaignId}`)
    for (const exp of EXPERIMENTS) {
      const outcome = await runAdsetExperiment(campaignId, exp)
      results.push({ ...exp, ...outcome })
      console.log(`${exp.id} ${outcome.pass ? 'PASS' : 'FAIL'} ${outcome.error ? JSON.stringify(outcome.error) : ''}`)
      await sleep(3000)
    }
    try {
      await createAdCreativeFromPost(AD_ACCOUNT_ID, FB_STORY_OBJECT, `FlowX-Probe-Story-${Date.now()}`, TOKEN, true)
      results.push({ id: 'E6', question: 'FB story object as ad creative (story boostability)', pass: true, error: null, expect: 'unknown' })
      console.log('E6 PASS')
    } catch (err) {
      const error = extractMetaError(err)
      results.push({ id: 'E6', question: 'FB story object as ad creative (story boostability)', pass: false, error, expect: 'unknown' })
      console.log(`E6 FAIL ${JSON.stringify(error)}`)
    }
    void FB_POST_OBJECT
  } finally {
    if (campaignId) {
      try {
        await deleteAdCampaign(campaignId, TOKEN)
        console.log(`probe campaign ${campaignId} deleted`)
      } catch (err) {
        console.error(`probe campaign ${campaignId} NOT deleted: ${err.message}`)
      }
    }
  }
  const lines = [
    '# Boost capability evidence (validate_only probes)',
    '',
    `- date: ${new Date().toISOString()}`,
    `- graph version: ${META_CONFIG.graphVersion}`,
    `- ad account: ${AD_ACCOUNT_ID}`,
    `- method: validate_only adset/creative creation (no spend, no delivery); probe campaign created PAUSED and deleted afterwards`,
    '',
    '| id | question | result | meta error | prior expectation |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.question} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.error ? `\`${JSON.stringify(r.error)}\`` : '—'} | ${r.expect} |`),
    '',
  ]
  writeFileSync(new URL('../../docs/boost-capability-evidence.md', import.meta.url), `${lines.join('\n')}`)
  console.log('evidence written to docs/boost-capability-evidence.md')
  await closePool()
}

main().catch(async (err) => {
  console.error(`probe failed: ${err.message}`)
  await closePool()
  process.exit(1)
})
