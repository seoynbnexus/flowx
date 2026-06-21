import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: parseInt(process.env.SMTP_PORT || '465', 10) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const from = {
  name: process.env.SMTP_FROM_NAME || 'FlowX',
  address: process.env.SMTP_FROM || 'noreply@flowx.com',
};

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

function otpEmailHtml(otp) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;padding:24px;background:#f5f5f5">
  <div style="max-width:480px;margin:auto;background:white;border-radius:8px;padding:32px;text-align:center">
    <h2 style="margin-top:0">Your verification code</h2>
    <p style="color:#666;margin-bottom:24px">Use this code to complete your registration:</p>
    <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#2563eb;padding:16px;background:#f0f4ff;border-radius:8px;font-family:monospace">${otp}</div>
    <p style="color:#999;font-size:12px;margin-top:24px">This code expires in 10 minutes.</p>
  </div>
</body>
</html>`;
}

function passwordResetHtml(token) {
  const link = `${BASE_URL}/api/v1/auth/reset-password?token=${token}`;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;padding:24px;background:#f5f5f5">
  <div style="max-width:480px;margin:auto;background:white;border-radius:8px;padding:32px">
    <h2 style="margin-top:0">Reset your password</h2>
    <p>Click the button below to reset your password:</p>
    <a href="${link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;margin:16px 0">Reset Password</a>
    <p>Or paste this link in your browser:</p>
    <p style="word-break:break-all;font-size:12px;color:#666">${link}</p>
    <p>This link expires in 1 hour.</p>
  </div>
</body>
</html>`;
}

export async function sendOtpEmail(to, otp) {
  await transporter.sendMail({
    from,
    to,
    subject: 'Your verification code',
    html: otpEmailHtml(otp),
  });
}

export async function sendPasswordResetEmail(to, token) {
  await transporter.sendMail({
    from,
    to,
    subject: 'Reset your password',
    html: passwordResetHtml(token),
  });
}
