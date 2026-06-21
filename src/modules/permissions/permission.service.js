import * as repo from './permission.repository.js';

export async function list() {
  return repo.findAll();
}

export async function listModules() {
  return repo.findModules();
}
