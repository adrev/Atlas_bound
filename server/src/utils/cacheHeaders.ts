import type { RequestHandler, Response } from 'express';

export const PRIVATE_NO_STORE = 'private, no-store, no-cache, must-revalidate';
export const PUBLIC_COMPENDIUM_CACHE = 'public, max-age=300, stale-while-revalidate=60';

export function setPrivateNoStore(res: Response): void {
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
}

export function setPublicCompendiumCache(res: Response): void {
  res.setHeader('Cache-Control', PUBLIC_COMPENDIUM_CACHE);
}

export const privateNoStoreCache: RequestHandler = (_req, res, next) => {
  setPrivateNoStore(res);
  next();
};

export const publicCompendiumCache: RequestHandler = (_req, res, next) => {
  setPublicCompendiumCache(res);
  next();
};
