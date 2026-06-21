import { query } from '../../../shared/database/connection.js';
import { bufferToUuid } from '../../../shared/utils/uuid.utils.js';

export async function findAll() {
  const rows = await query('SELECT * FROM permissions ORDER BY module, code');
  return rows.map(r => ({
    ...r,
    id: bufferToUuid(r.id),
  }));
}

export async function findModules() {
  const rows = await query('SELECT DISTINCT module FROM permissions ORDER BY module');
  return rows.map(r => r.module);
}

export async function findByIds(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const buffers = ids.map(id => Buffer.from(id.replace(/-/g, ''), 'hex'));
  const rows = await query(
    `SELECT * FROM permissions WHERE id IN (${placeholders})`,
    buffers
  );
  return rows.map(r => ({
    ...r,
    id: bufferToUuid(r.id),
  }));
}
