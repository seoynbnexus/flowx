import nodemailer from 'nodemailer'
import { queryOne } from '../database/connection.js'
import { uuidToBuffer } from '../utils/uuid.utils.js'
import { createNotification } from '../../src/modules/notifications/notifications.repository.js'
import { sendPublisherRepublishEmail } from './mailer.js'

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: parseInt(process.env.SMTP_PORT || '465', 10) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
})

const from = {
  name: process.env.SMTP_FROM_NAME || 'FlowX',
  address: process.env.SMTP_FROM || 'noreply@flowx.com',
}

const ALERT_RECIPIENTS = (process.env.ADMIN_ALERT_EMAILS || '')
  .split(',')
  .map(e => e.trim())
  .filter(Boolean)

export async function sendAdminAlert(subject, body, recipients = ALERT_RECIPIENTS) {
  if (!recipients.length || !process.env.SMTP_HOST) return false
  try {
    await transporter.sendMail({
      from,
      to: recipients,
      subject: `[FlowX Alert] ${subject}`,
      text: body,
    })
    return true
  } catch (err) {
    console.error('Admin alert email failed:', err.message)
    return false
  }
}

export async function sendPublisherRepublishNotification(publisherId, campaignId, campaignName) {
  try {
    const user = await queryOne(
      `SELECT u.email, up.first_name
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = ?`,
      [uuidToBuffer(publisherId)]
    )
    const firstName = user?.first_name || 'there'
    await createNotification(
      publisherId,
      'campaign_republish',
      'Campaign updated — republish required',
      `The campaign "${campaignName}" you published has been updated by the client. Please review and republish.`,
      { campaignId, campaignName }
    )
    if (user?.email && process.env.SMTP_HOST) {
      try {
        await sendPublisherRepublishEmail(user.email, firstName, campaignName, process.env.FRONTEND_URL || 'http://localhost:3000')
      } catch (err) {
        console.error('Publisher republish email failed:', err.message)
      }
    }
    return true
  } catch (err) {
    console.error('Publisher republish notification failed:', err.message)
    return false
  }
}