import { useSessionStore } from '../stores/useSessionStore';
import { useMapStore } from '../stores/useMapStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import type { Token, Combatant } from '@dnd-vtt/shared';
import { recordEventId, getLastEventId } from './eventCursor';

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

// ETag from the last 200 response, sent back as If-None-Match so the server
// can answer 304 (unchanged) and we skip the JSON parse + full reconcile.
// Scoped to the session it came from: navigating to a different session must
// NOT send the previous session's ETag (the server now namespaces the ETag
// by sessionId, but clearing it client-side also avoids a needless
// round-trip + keeps the two in lockstep).
let lastStateEtag: string | null = null;
let lastStateEtagSessionId: string | null = null;

function combatantsChanged(current: Combatant[], next: Combatant[]): boolean {
  if (current.length !== next.length) return true;
  return next.some((n, index) => {
    const c = current[index];
    if (!c) return true;
    return (
      c.tokenId !== n.tokenId ||
      c.characterId !== n.characterId ||
      c.name !== n.name ||
      c.initiative !== n.initiative ||
      c.initiativeBonus !== n.initiativeBonus ||
      c.hp !== n.hp ||
      c.maxHp !== n.maxHp ||
      c.tempHp !== n.tempHp ||
      c.armorClass !== n.armorClass ||
      c.speed !== n.speed ||
      c.isNPC !== n.isNPC ||
      c.portraitUrl !== n.portraitUrl ||
      c.exhaustionLevel !== n.exhaustionLevel ||
      c.hasAlert !== n.hasAlert ||
      c.surprised !== n.surprised ||
      c.deathSaveRolledRound !== n.deathSaveRolledRound ||
      JSON.stringify(c.conditions) !== JSON.stringify(n.conditions) ||
      JSON.stringify(c.deathSaves) !== JSON.stringify(n.deathSaves) ||
      JSON.stringify(c.initiativeBreakdown) !== JSON.stringify(n.initiativeBreakdown)
    );
  });
}

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

  // Drop a cached ETag that belongs to a different session — never send
  // session A's validator while polling session B.
  if (lastStateEtagSessionId !== sessionId) {
    lastStateEtag = null;
    lastStateEtagSessionId = sessionId;
  }

  try {
    const headers: Record<string, string> = {};
    if (lastStateEtag) headers['If-None-Match'] = lastStateEtag;
    const resp = await fetch(`/api/sessions/${sessionId}/state`, {
      credentials: 'include',
      headers,
    });

    // 304 Not Modified — nothing changed since our last pull. Keep the
    // cached state, skip the parse + reconcile entirely.
    if (resp.status === 304) return { ok: true, applied: false };

    if (!resp.ok) return { ok: false, applied: false };
    const newEtag = resp.headers.get('ETag');
    if (newEtag) {
      lastStateEtag = newEtag;
      lastStateEtagSessionId = sessionId;
    }

    const snap = (await resp.json()) as {
      mapId?: string | null;
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

    // STALENESS GUARD: a /state response can land AFTER live socket
    // events that the server read happened BEFORE (HTTP overtaken by
    // websocket). nextEventId is the room's monotonic event counter at
    // snapshot time; if we've already applied newer live events, this
    // snapshot is provably older than our state — applying it would
    // rubber-band token positions and rewind combat (turn indicator
    // jumping backwards). Discard; the next poll re-converges.
    if (typeof snap.nextEventId === 'number' && snap.nextEventId < getLastEventId()) {
      return { ok: true, applied: false };
    }

    // Guard against a non-authoritative "no room on this instance"
    // snapshot wiping real local state. The server returns an empty
    // snapshot with nextEventId 0 when getRoom() is null — e.g. a Cloud
    // Run session-affinity miss, or an instance that just restarted and
    // hasn't rehydrated the room. nextEventId is monotonic, so a session
    // that has ever had activity always reports > 0; only this fallback
    // (or a pristine, genuinely-empty room) reports 0. Reconciling an
    // empty fallback over real state would wipe the map + end combat from
    // a stale source — skip it; the socket and the next poll to the
    // authoritative instance self-heal.
    if (
      snap.nextEventId === 0 &&
      snap.tokens.length === 0 &&
      !snap.combat &&
      (Object.keys(useMapStore.getState().tokens).length > 0 || useCombatStore.getState().active)
    ) {
      return { ok: true, applied: false };
    }

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
    // path. Newer servers send `mapId` even for empty maps; keep
    // token-based fallback for legacy responses.
    const snapshotMapId = snap.mapId ?? snap.tokens[0]?.mapId ?? mapStore.currentMap?.id;
    if (snapshotMapId && snapshotMapId === mapStore.currentMap?.id) {
      // Diff to detect actual changes — avoids re-rendering the
      // whole token layer every 15 s if nothing changed.
      const currentIds = Object.keys(mapStore.tokens).sort().join(',');
      const nextIds = Object.keys(nextTokens).sort().join(',');
      const changed =
        currentIds !== nextIds ||
        Object.values(nextTokens).some((t) => {
          const existing = mapStore.tokens[t.id];
          if (!existing) return true;
          // Shallow comparison on every render-relevant field. This used
          // to check only pos/size/image/visible/conditions, which meant
          // a missed map:token-updated that changed lights, name, layer,
          // or ownership NEVER self-healed — the diff declared
          // "unchanged" forever (e.g. a torch lit during a socket gap
          // left that player in darkness for the rest of the scene).
          return (
            existing.x !== t.x ||
            existing.y !== t.y ||
            existing.size !== t.size ||
            existing.imageUrl !== t.imageUrl ||
            existing.visible !== t.visible ||
            existing.name !== t.name ||
            existing.layer !== t.layer ||
            existing.ownerUserId !== t.ownerUserId ||
            existing.characterId !== t.characterId ||
            existing.hasLight !== t.hasLight ||
            existing.lightRadius !== t.lightRadius ||
            existing.lightDimRadius !== t.lightDimRadius ||
            existing.lightColor !== t.lightColor ||
            existing.color !== t.color ||
            JSON.stringify(existing.conditions) !== JSON.stringify(t.conditions)
          );
        });
      if (changed) {
        useMapStore.setState({ tokens: nextTokens });
      }
    }

    // ── Combat: server is authoritative for round / turn / combatants.
    //    If server says combat is null (not active), clear locally.
    const combatStore = useCombatStore.getState();
    if (snap.combat) {
      if (!combatStore.active) {
        // Combat genuinely started while we were desynced — full init.
        combatStore.startCombat(snap.combat.combatants, snap.combat.roundNumber);
        // startCombat resets currentTurnIndex to 0 — force the server's
        // value after, since it knows where the turn cursor actually is.
        useCombatStore.setState({ currentTurnIndex: snap.combat.currentTurnIndex });
      } else if (
        combatStore.roundNumber !== snap.combat.roundNumber ||
        combatStore.currentTurnIndex !== snap.combat.currentTurnIndex ||
        combatantsChanged(combatStore.combatants, snap.combat.combatants)
      ) {
        // Mid-combat drift (hidden-token reveal growing the list, a
        // reinforcement, a missed turn-advance): MERGE the authoritative
        // trio. This used to call startCombat(), which also reset the
        // damage log (killing the end-of-battle recap), the action-
        // economy pills, the review phase, and the combat clock — every
        // time the DM revealed an ambusher or added a goblin.
        useCombatStore.setState({
          combatants: snap.combat.combatants,
          roundNumber: snap.combat.roundNumber,
          currentTurnIndex: snap.combat.currentTurnIndex,
        });
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
