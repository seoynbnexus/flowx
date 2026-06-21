import { v7 as uuidv7, parse as uuidParse, stringify as uuidStringify } from 'uuid';

export function generateUuid() {
  return uuidv7();
}

export function uuidToBuffer(uuidString) {
  return Buffer.from(uuidParse(uuidString));
}

export function bufferToUuid(buffer) {
  if (!buffer) return null;
  return uuidStringify(buffer);
}

export function uuidFromBuffer(buffer) {
  return bufferToUuid(buffer);
}
