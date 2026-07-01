import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SALT_ROUNDS = parseInt(process.env.SALT || '10', 10);
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function generateRandomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateOtp(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[crypto.randomInt(0, digits.length)];
  }
  return otp;
}

export function encrypt(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
