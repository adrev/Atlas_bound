type TargetingResolver = (event: Event) => void | Promise<void>;

interface TargetingDispatcher {
  resolvers: Set<TargetingResolver>;
  dispatch: (event: Event) => Promise<void>;
}

const dispatchers = new WeakMap<EventTarget, TargetingDispatcher>();

function createDispatcher(): TargetingDispatcher {
  const resolvers = new Set<TargetingResolver>();
  let inFlight = false;

  return {
    resolvers,
    dispatch: async (event) => {
      if (inFlight) return;
      const resolver = resolvers.values().next().value;
      if (!resolver) return;

      // Claim synchronously, before the resolver can yield to a reaction window.
      inFlight = true;
      try {
        await resolver(event);
      } catch (error) {
        console.error('[Targeting] Failed to resolve target', error);
      } finally {
        inFlight = false;
      }
    },
  };
}

/** One listener/flight shared by the canvas, Hero tab, and mobile panels. */
export function registerTargetingResolver(
  target: EventTarget,
  resolver: TargetingResolver
): () => void {
  let dispatcher = dispatchers.get(target);
  if (!dispatcher) {
    dispatcher = createDispatcher();
    dispatchers.set(target, dispatcher);
  }

  const { resolvers, dispatch } = dispatcher;
  if (resolvers.size === 0) target.addEventListener('target-token-selected', dispatch);
  resolvers.add(resolver);

  return () => {
    resolvers.delete(resolver);
    if (resolvers.size === 0) target.removeEventListener('target-token-selected', dispatch);
    // Retain the dispatcher in the WeakMap: a pending cast must stay locked
    // even if every panel's effect cleans up and re-registers before it settles.
  };
}
