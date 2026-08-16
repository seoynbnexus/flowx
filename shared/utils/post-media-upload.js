import multer from 'multer'
import path from 'path'
import { v7 as generateUuid } from 'uuid'
import fs from 'fs'
import { ValidationError } from '../errors/AppError.js'

export const ALLOWED_MEDIA_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
}

export const ALLOWED_MEDIA_MIMES = new Set([
  ...ALLOWED_MEDIA_TYPES.image,
  ...ALLOWED_MEDIA_TYPES.video,
])

export const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024

export const MAX_MEDIA_FILE_BYTES = parseInt(process.env.POST_MEDIA_MAX_FILE_BYTES, 10) || DEFAULT_MAX_FILE_BYTES

export const MEDIA_UPLOAD_DIR = path.resolve('public/uploads/posts')
if (!fs.existsSync(MEDIA_UPLOAD_DIR)) {
  fs.mkdirSync(MEDIA_UPLOAD_DIR, { recursive: true })
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
}

export function mediaKindForMime(mimeType) {
  if (ALLOWED_MEDIA_TYPES.image.includes(mimeType)) return 'image'
  if (ALLOWED_MEDIA_TYPES.video.includes(mimeType)) return 'video'
  return null
}

export function extensionForMime(mimeType) {
  return EXT_BY_MIME[mimeType] || null
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, MEDIA_UPLOAD_DIR)
  },
  filename: (_req, file, cb) => {
    const ext = extensionForMime(file.mimetype) || path.extname(file.originalname).toLowerCase() || '.jpg'
    cb(null, `${generateUuid()}${ext}`)
  },
})

function fileFilter(_req, file, cb) {
  if (ALLOWED_MEDIA_MIMES.has(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new ValidationError(`Invalid media type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM`))
  }
}

export const uploadPostMedia = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_MEDIA_FILE_BYTES },
}).single('file')