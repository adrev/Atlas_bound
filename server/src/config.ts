import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = parseInt(process.env.PORT ?? '3001', 10);

export const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'dnd-vtt.db');

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(__dirname, '..', 'uploads');

export const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
