import { Worker } from 'node:worker_threads';
import type { ChroniclerInput, ChroniclerOutput, ChroniclerError } from './Chronicler.js';
import { VERTEX_TIMEOUT_MS } from './ChronicleJobs.js';

/** Keep SDK/auth work inside a killable lifetime, including credential discovery. */
export async function executeChronicle(
  input: ChroniclerInput,
  signal?: AbortSignal
): Promise<ChroniclerOutput | ChroniclerError> {
  if (signal?.aborted)
    return { error: 'Chronicle request interrupted', hint: 'Retry to start a new attempt.' };
  const sourceMode = import.meta.url.endsWith('.ts');
  const entry = new URL(`./ChronicleVertexWorker.${sourceMode ? 'ts' : 'js'}`, import.meta.url);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    worker = sourceMode
      ? new Worker(
          `import('tsx/esm/api').then(({ tsImport }) => tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)})).catch(e => { throw e; });`,
          { eval: true, workerData: input }
        )
      : new Worker(entry, { workerData: input });
    const activeWorker = worker;
    return await new Promise<ChroniclerOutput | ChroniclerError>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            error: 'Chronicle generation timed out',
            hint: 'Retry to start a new attempt.',
          }),
        VERTEX_TIMEOUT_MS
      );
      onAbort = () =>
        resolve({ error: 'Chronicle request interrupted', hint: 'Retry to start a new attempt.' });
      signal?.addEventListener('abort', onAbort, { once: true });
      activeWorker.once('message', resolve);
      activeWorker.once('error', (err: unknown) =>
        resolve({
          error: 'Vertex AI worker failed',
          hint: err instanceof Error ? err.message : String(err),
        })
      );
      activeWorker.once('exit', () =>
        resolve({ error: 'Vertex AI worker exited before returning a result' })
      );
    });
  } catch (err) {
    return {
      error: 'Vertex AI worker failed',
      hint: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    // Await termination before the route can acknowledge or persist the result.
    await worker?.terminate();
  }
}
