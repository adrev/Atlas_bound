import { emitSpellCastAttempt } from './emitters';

/**
 * How long the counterspell window stays open. The counterer's prompt
 * (CounterspellModal) auto-dismisses after this, AND the caster's
 * resolver below waits exactly this long for a response — they MUST
 * match. The old resolver waited 1400ms while the prompt gave the
 * counterer 8s, so a counter clicked at a human pace never reached the
 * caster and the spell resolved anyway.
 */
export const COUNTERSPELL_WINDOW_MS = 8_000;

/**
 * Broadcast a leveled-spell cast and wait for a counterspell.
 *
 * Returns true if a `spell-counterspelled` window event with our castId
 * arrives before the window closes (the caller then aborts the spell's
 * effects — slot and action are already spent). The counter travels
 * caster → server → all clients: the counterer emits
 * `combat:spell-counterspelled`, the server relays it room-wide, and the
 * caster's socket listener turns it back into the window event awaited
 * here. Resolves false on timeout (no counter).
 */
export async function broadcastCastAndAwaitCounterspell(args: {
  casterTokenId: string;
  casterName: string;
  spellName: string;
  spellLevel: number;
}): Promise<boolean> {
  // Cantrips / slot-zero can't be counterspelled in 5e.
  if (args.spellLevel <= 0) return false;

  const castId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  emitSpellCastAttempt({ ...args, castId });

  return new Promise<boolean>((resolve) => {
    // The resolver short-circuits the instant a matching counter arrives,
    // so this timeout is only the no-counter worst case, not a fixed delay.
    const timeout = setTimeout(() => {
      window.removeEventListener('spell-counterspelled', onCounter as EventListener);
      resolve(false);
    }, COUNTERSPELL_WINDOW_MS);
    function onCounter(e: Event) {
      const detail = (e as CustomEvent).detail as { castId?: string };
      // A counter for a different cast in flight — ignore it.
      if (detail?.castId && detail.castId !== castId) return;
      clearTimeout(timeout);
      window.removeEventListener('spell-counterspelled', onCounter as EventListener);
      resolve(true);
    }
    window.addEventListener('spell-counterspelled', onCounter as EventListener);
  });
}
