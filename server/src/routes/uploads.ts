import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { UPLOAD_DIR } from '../config.js';

// Ensure upload directories exist
const mapUploadsDir = path.join(UPLOAD_DIR, 'maps');
const tokenUploadsDir = path.join(UPLOAD_DIR, 'tokens');
const portraitUploadsDir = path.join(UPLOAD_DIR, 'portraits');

for (const dir of [mapUploadsDir, tokenUploadsDir, portraitUploadsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

function createStorage(subDir: string) {
  return multer.diskStorage({
    destination(_req, _file, cb) {
      const dir = path.join(UPLOAD_DIR, subDir);
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `${uuidv4()}${ext}`);
    },
  });
}

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
  }
}

export const mapUpload = multer({
  storage: createStorage('maps'),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

export const tokenUpload = multer({
  storage: createStorage('tokens'),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

export const portraitUpload = multer({
  storage: createStorage('portraits'),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});
