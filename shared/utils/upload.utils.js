import multer from 'multer';
import path from 'path';
import { v7 as generateUuid } from 'uuid';
import fs from 'fs';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE, 10) || 5 * 1024 * 1024;

const uploadDir = path.resolve('public/uploads/identity');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${generateUuid()}${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: JPEG, PNG, PDF`));
  }
}

export const uploadIdentity = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE },
}).single('file');
