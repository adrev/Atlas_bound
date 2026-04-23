import { useMapStore } from '../stores/useMapStore';
import { useCharacterStore } from '../stores/useCharacterStore';
import { useCombatStore } from '../stores/useCombatStore';
import { useSessionStore } from '../stores/useSessionStore';
import type { Token } from '@dnd-vtt/shared';

/**
 * Replay dispatcher — the client half of the event-cursor resync
 * protocol. When the client detects it's behind the server's event
 * log (after a socket hiccup, tab return, or periodic keep-alive),
 * it fetches the delta from /api/sessions/:id/events?since=N and
 * feeds each missed event through this dispatcher.
 *
 * Handlers here MUST be idempotent with the live socket listeners
 * (listeners.ts) — replayed events run through this file instead of
 * `socket.on(...)` handlers, so any shared store update needs to
 * produce the same end state regardless of which path ran it.
 *
 * We deliberately cover a narrow set: the events most likely to be
 * missed and most visible to the user (token moves, token adds /
 * removes, character updates, combat lifecycle + turn advancement,
 * chat). Anything else that arrives in the delta is currently
 * ignored — those are low-frequency and typically re-synthesized
 * by the next session:join hydration.
 */
export function dispatchReplayEvent(
  kind: string,
  payload: Record<string, unknown>,
): void {
  switch (kind) {
    case 'map:token-moved': {
      const { tokenId, x, y } = payload as { tokenId: string; x: number; y: number };
      const token = useMapStore.getState().tokens[tokenId];
      if (token) useMapStore.getState().moveToken(tokenId, x, y);
      return;
    }
    case 'map:token-added': {
      const token = payload as unknown as Token;
      useMapStore.getState().addToken(token);
      return;
    }
    case 'map:token-removed': {
      const { tokenId } = payload as { tokenId: string };
      useMapStore.getState().removeToken(tokenId);
      return;
    }
    case 'map:token-updated': {
      const { tokenId, changes } = payload as { tokenId: string; changes: Partial<Token> };
      useMapStore.getState().updateToken(tokenId, changes);
      return;
    }
    case 'character:updated': {
      const { characterId, changes } = payload as {
        characterId: string;
        changes: Record<string, unknown>;
      };
      useCharacterStore.getState().applyRemoteUpdate(characterId, changes);
      return;
    }
    case 'combat:ended': {
      useCombatStore.getState().endCombat();
      useSessionStore.getState().setGameMode('free-roam');
      return;
    }
    case 'combat:turn-advanced': {
      const { currentTurnIndex, roundNumber, actionEconomy } = payload as {
        currentTurnIndex: number;
        roundNumber: number;
        actionEconomy?: { action: boolean; bonusAction: boolean; movementRemaining: number; movementMax: number; reaction: boolean };
      };
      if (actionEconomy) {
        useCombatStore.getState().nextTurn(currentTurnIndex, roundNumber, actionEconomy);
      }
      return;
    }
    // Silently drop anything we don't know how to replay — a future
    // session:join hydration will pull the authoritative state for
    // unhandled kinds. Adding a handler here for a new event is the
    // way to broaden coverage.
    default:
      return;
  }
}
