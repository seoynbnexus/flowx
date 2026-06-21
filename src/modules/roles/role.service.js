import * as repo from './role.repository.js';
import { NotFoundError, ConflictError } from '../../../shared/errors/AppError.js';

export async function list() {
  return repo.findAll();
}

export async function getById(id) {
  const role = await repo.findById(id);
  if (!role) throw new NotFoundError('Role not found');
  return role;
}

export async function create(data) {
  const existing = await repo.findByCode(data.code);
  if (existing) throw new ConflictError('Role with this code already exists');

  return repo.create(data);
}

export async function update(id, data) {
  const role = await repo.findById(id);
  if (!role) throw new NotFoundError('Role not found');
  if (role.is_system) throw new ConflictError('Cannot modify system roles');

  return repo.update(id, data);
}

export async function remove(id) {
  const role = await repo.findById(id);
  if (!role) throw new NotFoundError('Role not found');
  if (role.is_system) throw new ConflictError('Cannot delete system roles');

  await repo.remove(id);
}

export async function getPermissions(roleId) {
  const role = await repo.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  return repo.getPermissions(roleId);
}

export async function assignPermissions(roleId, permissionIds) {
  const role = await repo.findById(roleId);
  if (!role) throw new NotFoundError('Role not found');

  await repo.setPermissions(roleId, permissionIds);
}
