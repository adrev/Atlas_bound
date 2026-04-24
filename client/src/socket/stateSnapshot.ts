import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import type { Token, Combatant } from '@dnd-vtt/shared';
import { recordEventId } from './eventCursor';

/**
 * Debounced snapshot trigger. Callers (UI actions, socket listeners)
 * call this the moment they know the server side has just mutated,
 * and the actual /state fetch fires once after a short quiet window.
 *
 * Why debounce at all? A single "fire a spell" flow fans out into
 * several back-to-back events (token-updated, character:updated,
 * combat:action-used, chat:new-message). Each one should ideally
 * resync, but doing four parallel /state fetches burns bandwidth
 * for no gain — the last one would win anyway. 150 ms groups a burst
 * into one request while still feeling instant (well under the
 * human-perception threshold of ~200 ms).
 *
 * The periodic 5 s keep-alive still runs independently as the
 * ultimate floor — if every trigger site gets removed tomorrow,
 * sync is still guaranteed within 5 seconds.
 */
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let lastSnapshotAt = 0;
const MIN_INTERVAL_MS = 80;

/**
 * Schedule an authoritative state resync from the server. Safe to
 * call from anywhere — event listeners, UI handlers, imperative
 * code. Repeat calls within a 150 ms window are coalesced into a
 * single HTTP fetch; that keeps a multi-event turn (attack roll +
 * damage + condition apply + action economy + chat line) from
 * hammering the endpoint.
 *
 * Optional `reason` string for observability — not sent to the
 * server, just logged for local debugging.
 */
export function triggerSnapshot(_reason?: string): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  // Hard floor so rapid-fire triggers (e.g. a token drag emitting
  // 30 move events/sec) can't escalate into 30 HTTP calls.
  const elapsed = Date.now() - lastSnapshotAt;
  const delay = elapsed < MIN_INTERVAL_MS ? MIN_INTERVAL_MS - elapsed : 150;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    lastSnapshotAt = Date.now();
    void pullStateSnapshot();
  }, delay);
}

/**
 * Authoritative state reconciler.
 *
 * The client polls `GET /api/sessions/:id/state` every keep-alive
 * tick (15 s). The server's response is the ground truth: we
 * reconcile our local stores against it so ANY drift — no matter
 * how it happened (dead socket, unwrapped broadcast, OS-paused
 * timer) — self-heals inside one tick.
 *
 * Reconciliation rules:
 *   - Tokens: replace the store's token map with the server's list
 *     for this map. Lose stale entries, gain ones we missed.
 *   - Combat: if server says active, use server's round / turn / combatants;
 *     if server says null, clear combat locally.
 *   - Characters: apply `applyRemoteSync` for each returned character
 *     (already an upsert — handles adds + updates).
 *
 * Unlike the event-cursor replay, this doesn't need handlers to be
 * idempotent — we're just copying server state directly. And unlike
 * `session:join`, it doesn't re-send heavy scenes/walls/drawings
 * every 15 s.
 */
export async function pullStateSnapshot(): Promise<{ ok: boolean; applied: boolean }> {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) return { ok: false, applied: false };

  try {
    const resp = await fetch(
      `/api/sessions/${sessionId}/state`,
      { credentials: 'include' },
    );
    if (!resp.ok) return { ok: false, applied: false };

    const snap = (await resp.json()) as {
      tokens: Token[];
      combat: null | {
        active: boolean;
        roundNumber: number;
        currentTurnIndex: number;
        combatants: Combatant[];
        startedAt: number;
      };
      characters: Record<string, unknown>;
      nextEventId: number;
      roundNumber: number;
    };

    // ── Tokens: replace the snapshot for the active map. We only
    //    get tokens on the caller's current map from the server, so
    //    we rebuild the store's view of this map-scope and leave
    //    any DM preview tokens (on a different map) untouched —
    //    those live in mapStore when the DM navigates there.
    const mapStore = useMapStore.getState();
    const nextTokens: Record<string, Token> = {};
    for (const t of snap.tokens) nextTokens[t.id] = t;
    // If the current map is the one the server snapshotted for,
    // replace. Otherwise leave the store alone — the DM is on a
    // preview map and will get its own snapshot on its hydration
    // path. We recognize "same map" via the first token's mapId.
    const activeMapId = snap.tokens[0]?.mapId ?? mapStore.currentMap?.id;
    if (activeMapId && activeMapId === mapStore.currentMap?.id) {
      // Diff to detect actual changes — avoids re-rendering the
      // whole token layer every 15 s if nothing changed.
      const currentIds = Object.keys(mapStore.tokens).sort().join(',');
      const nextIds = Object.keys(nextTokens).sort().join(',');
      const changed = currentIds !== nextIds || Object.values(nextTokens).some((t) => {
        const existing = mapStore.tokens[t.id];
        if (!existing) return true;
        // Cheap shallow comparison on the fields that actually drive
        // re-renders. Pos / size / image / conditions / hp-ish.
        return existing.x !== t.x || existing.y !== t.y
          || existing.size !== t.size || existing.imageUrl !== t.imageUrl
          || existing.visible !== t.visible
          || JSON.stringify(existing.conditions) !== JSON.stringify(t.conditions);
      });
      if (changed) {
        useMapStore.setState({ tokens: nextTokens });
      }
    }

    // ── Combat: server is authoritative. If the server says we're
    //    in a round, adopt round / turn / combatants. If server says
    //    combat is null (not active), clear locally.
    const combatStore = useCombatStore.getState();
    if (snap.combat) {
      if (!combatStore.active
        || combatStore.roundNumber !== snap.combat.roundNumber
        || combatStore.currentTurnIndex !== snap.combat.currentTurnIndex
        || combatStore.combatants.length !== snap.combat.combatants.length) {
        combatStore.startCombat(snap.combat.combatants, snap.combat.roundNumber);
        // startCombat resets currentTurnIndex to 0 — force the server's
        // value after, since it knows where the turn cursor actually is.
        useCombatStore.setState({ currentTurnIndex: snap.combat.currentTurnIndex });
      }
    } else if (combatStore.active) {
      combatStore.endCombat();
      useSessionStore.getState().setGameMode('free-roam');
    }

    // ── Characters: apply every one through the existing remote-sync
    //    path, which is already idempotent.
    const charStore = useCharacterStore.getState();
    for (const charRow of Object.values(snap.characters ?? {})) {
      charStore.applyRemoteSync(charRow as Record<string, unknown>);
    }

    // ── Advance the event cursor so the next /events?since=N call
    //    doesn't redundantly replay the same data we just reconciled.
    if (typeof snap.nextEventId === 'number') {
      recordEventId(snap.nextEventId);
    }

    return { ok: true, applied: true };
  } catch {
    return { ok: false, applied: false };
  }
}
