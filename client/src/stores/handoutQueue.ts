export interface HandoutPayload {
  title: string;
  content: string;
  imageUrl?: string;
  fromDM: boolean;
}

type Listener = () => void;

let queue: readonly HandoutPayload[] = [];
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function getHandoutQueue(): readonly HandoutPayload[] {
  return queue;
}

export function subscribeToHandoutQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pushHandout(payload: HandoutPayload): void {
  queue = [...queue, payload];
  notify();
}

export function dismissHandout(): void {
  if (queue.length === 0) return;
  queue = queue.slice(1);
  notify();
}

/** Test-only reset; avoids exporting mutable queue state to production callers. */
export function resetHandoutQueueForTests(): void {
  queue = [];
  notify();
}
