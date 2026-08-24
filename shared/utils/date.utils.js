import { ValidationError } from '../errors/AppError.js';

const MYSQL_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toMySqlTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  // Already in MySQL UTC format — pass through untouched
  if (typeof value === 'string' && MYSQL_TS_RE.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('Invalid datetime value');
  }
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function fromMySqlTimestamp(value) {
  if (!value) return null;
  // If already a Date, convert to ISO string
  if (value instanceof Date) {
    return value.toISOString();
  }
  // If string in MySQL format (YYYY-MM-DD HH:MM:SS), treat as UTC
  if (typeof value === 'string' && MYSQL_TS_RE.test(value)) {
    // Parse as UTC by appending 'Z' and using Date.UTC
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (parts) {
      const [, year, month, day, hour, minute, second] = parts;
      return new Date(Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second)
      )).toISOString();
    }
    // Fallback: try appending Z (but this may still parse as local)
    return new Date(value + 'Z').toISOString();
  }
  // Fallback for other formats
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

