import type { Request, Response } from 'express';
import { afterCommit } from '../db/transactionContext.js';
import { withSessionRuntime, sessionRuntimeConfigured } from '../services/SessionRuntime.js';
import { assertSessionMember, getAuthUserId } from './authorization.js';

/** Reconciliation reads the same locked state as socket actions, not whichever
 * stale room happens to be cached on the HTTP request's instance. */
export function runtimeHttp(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!sessionRuntimeConfigured()) return handler(req, res);
    await assertSessionMember(String(req.params.id), getAuthUserId(req));
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<Response['end']>) => {
      afterCommit(() => Reflect.apply(end, res, args));
      return res;
    }) as Response['end'];
    try {
      await withSessionRuntime(String(req.params.id), () => handler(req, res));
    } finally {
      res.end = end;
    }
  };
}
