import { searchMeta } from '../../../shared/services/meta-ads.service.js'
import { sendSuccess } from '../../../shared/utils/response.utils.js'

const LOCATION_TYPE_MAP = {
  adregion: ['region'],
  adcity: ['city'],
  adzip: ['zip'],
  adcountry: ['country'],
}

export async function metaSearch(req, res, next) {
  try {
    const { type, q } = req.query
    if (!type || !q) {
      return res.status(422).json({ success: false, message: 'type and q are required' })
    }

    const token = process.env.META_SYSTEM_USER_TOKEN
    if (!token) {
      return res.status(503).json({ success: false, message: 'Meta Ads not configured' })
    }

    const locationTypes = LOCATION_TYPE_MAP[type]
    const metaType = locationTypes ? 'adgeolocation' : 'adinterest'

    const results = await searchMeta({
      accessToken: token,
      type: metaType,
      q,
      extra: locationTypes ? { location_types: locationTypes } : {},
    })

    return sendSuccess(res, results)
  } catch (error) {
    next(error)
  }
}
