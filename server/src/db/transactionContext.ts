import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

interface TransactionContext {
  client: PoolClient;
  pending: Set<Promise<unknown>>;
  effects: Array<() => void | Promise<void>>;
  failure?: unknown;
  closed: boolean;
  savepoint: number;
}

const context = new AsyncLocalStorage<TransactionContext>();

/** Queue observable success until the writes that produced it have committed. */
export function afterCommit(effect: () => void): void {
  const current = context.getStore();
  if (!current) return effect();
  if (current.closed) throw new Error('Work escaped its database transaction');
  current.effects.push(effect);
}

export function deferUntilCommit(effect: () => Promise<void>): boolean {
  const current = context.getStore();
  if (!current) return false;
  if (current.closed) throw new Error('Work escaped its database transaction');
  current.effects.push(effect);
  return true;
}

export function outsideTransaction<T>(operation: () => T): T {
  return context.exit(operation);
}

function track<T>(current: TransactionContext, promise: Promise<T>): Promise<T> {
  current.pending.add(promise);
  // Observe every query, including legacy callers that swallow SQL failures.
  promise.then(
    () => current.pending.delete(promise),
    (error) => {
      current.failure ??= error;
      current.pending.delete(promise);
    }
  );
  return promise;
}

export function transactionAwarePool(raw: Pool): Pool {
  return new Proxy(raw, {
    get(target, property) {
      const current = context.getStore();
      if (current && property === 'query') {
        return (...args: Parameters<PoolClient['query']>) => {
          if (current.closed) return Promise.reject(new Error('Query after transaction completed'));
          const query = current.client.query as unknown as (
            ...values: unknown[]
          ) => Promise<unknown>;
          return track(current, query.apply(current.client, args));
        };
      }
      if (current && property === 'connect') {
        return async () => {
          const name = `nested_${++current.savepoint}`;
          let began = false;
          return new Proxy(current.client, {
            get(client, key) {
              if (key === 'release') return () => {};
              if (key === 'query')
                return (sql: string, values?: unknown[]) => {
                  if (current.closed)
                    return Promise.reject(new Error('Query after transaction completed'));
                  let query = sql;
                  if (typeof sql === 'string') {
                    if (/^BEGIN\s*;?$/i.test(sql)) {
                      query = `SAVEPOINT ${name}`;
                      began = true;
                    }
                    if (/^COMMIT\s*;?$/i.test(sql) && began) query = `RELEASE SAVEPOINT ${name}`;
                    if (/^ROLLBACK\s*;?$/i.test(sql) && began)
                      query = `ROLLBACK TO SAVEPOINT ${name}`;
                  }
                  return track(current, client.query(query, values));
                };
              const value = Reflect.get(client, key);
              return typeof value === 'function' ? value.bind(client) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function inTransaction<T>(raw: Pool, operation: () => Promise<T>): Promise<T> {
  if (context.getStore()) return operation();
  const client = await raw.connect();
  let released = false;
  const current: TransactionContext = {
    client,
    pending: new Set(),
    effects: [],
    closed: false,
    savepoint: 0,
  };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await context.run(current, operation);
    while (current.pending.size) await Promise.allSettled([...current.pending]);
    if (current.failure) throw current.failure;
    await client.query('COMMIT');
    current.closed = true;
    client.release();
    released = true;
    for (const effect of current.effects) {
      try {
        await outsideTransaction(effect);
      } catch (error) {
        console.error('[committed delivery]', error);
      }
    }
    return result;
  } catch (error) {
    current.closed = true;
    if (!released) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (!released) client.release();
  }
}
