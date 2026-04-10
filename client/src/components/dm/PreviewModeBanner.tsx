import { useEffect, useMemo, useState, useRef } from 'react';
import { X, UserPlus } from 'lucide-react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSceneStore } from '../../stores/useSceneStore';
import {
  emitPreviewLoadMap, emitActivateMapForPlayers, emitTokenAdd,
} from '../../socket/emitters';
import { Button } from '../ui';

/**
 * Docked banner shown above the canvas when a DM is previewing a
 * different map than the players. Reminds the DM "players aren't
 * seeing this" and offers two quick actions:
 *   • Jump to Players — preview-load the player ribbon map
 *   • Move Players Here — drop the ribbon on the DM's current view
 *
 * Rewritten for the UI unification pass to use the Button primitive
 * and shared theme tokens (no more hardcoded colors).
 */
export function PreviewModeBanner() {
  const isDM = useSessionStore((s) => s.isDM);
  const isPreviewing = useMapStore((s) => s.isDmPreviewingDifferentMap);
  const currentMap = useMapStore((s) => s.currentMap);
  const playerMapId = useMapStore((s) => s.playerMapId);
  const stagedHeroes = useMapStore((s) => s.stagedHeroes);
  const maps = useSceneStore((s) => s.maps);

  const playerMapSummary = useMemo(
    () => maps.find((m) => m.id === playerMapId) ?? null,
    [maps, playerMapId],
  );

  // Tracks the currentMap.id the DM manually dismissed the banner
  // for. Reset whenever the DM switches to a different preview map so
  // the banner re-appears naturally.
  const [dismissedForMapId, setDismissedForMapId] = useState<string | null>(null);
  const [showHeroPicker, setShowHeroPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentMap?.id !== dismissedForMapId) setDismissedForMapId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMap?.id]);

  // Close picker on outside click
  useEffect(() => {
    if (!showHeroPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowHeroPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHeroPicker]);

  // All hooks above — early returns below
  if (!isDM) return null;
  if (!isPreviewing) return null;
  if (!currentMap) return null;
  if (dismissedForMapId === currentMap.id) return null;

  const hasStaged = stagedHeroes.length > 0;

  const handleJumpToPlayers = () => {
    if (playerMapId) emitPreviewLoadMap(playerMapId);
  };

  /** Build a characterId -> ownerUserId lookup from the session players. */
  const buildOwnerMap = () => {
    const players = useSessionStore.getState().players;
    const map: Record<string, string> = {};
    for (const p of players) {
      if (p.characterId) map[p.characterId] = p.userId;
    }
    return map;
  };

  /** Stage a single hero at the center of the preview map. */
  const stageHero = (player: { userId: string; characterId: string; displayName: string }) => {
    const allChars = useCharacterStore.getState().allCharacters;
    const char = allChars[player.characterId];
    const gridSize = currentMap.gridSize ?? 70;
    const existing = useMapStore.getState().stagedHeroes;
    // Offset each new hero so they don't stack on top of each other
    const offset = existing.length * gridSize;
    const x = Math.round(currentMap.width / 2) + offset - (existing.length * gridSize / 2);
    const y = Math.round(currentMap.height / 2);

    useMapStore.getState().stageHeroes([
      ...existing,
      {
        characterId: player.characterId,
        name: char?.name ?? player.displayName,
        portraitUrl: char?.portraitUrl ?? null,
        x, y,
        ownerUserId: player.userId,
      },
    ]);
    // Keep picker open so DM can stage multiple heroes one by one
  };

  /** Get ALL player characters (staged + un-staged).
   *  Uses two sources to be comprehensive:
   *    1. Session players with linked characterIds (shows online status)
   *    2. All non-NPC characters from the store (catches heroes whose
   *       players disconnected or aren't in the session yet)
   */
  const getStageable = () => {
    const players = useSessionStore.getState().players;
    const allChars = useCharacterStore.getState().allCharacters;

    // Build a characterId -> player lookup for online status
    const charToPlayer: Record<string, { userId: string; displayName: string; connected: boolean }> = {};
    for (const p of players) {
      if (p.characterId) charToPlayer[p.characterId] = { userId: p.userId, displayName: p.displayName, connected: p.connected };
    }

    // Collect from both sources, dedup by characterId
    const seen = new Set<string>();
    const result: Array<{
      userId: string; characterId: string; displayName: string;
      characterName: string; portraitUrl: string | null; connected: boolean;
    }> = [];

    // Source 1: session players with characters
    for (const p of players) {
      if (!p.characterId || seen.has(p.characterId)) continue;
      seen.add(p.characterId);
      const char = allChars[p.characterId];
      result.push({
        userId: p.userId,
        characterId: p.characterId,
        displayName: p.displayName,
        characterName: char?.name ?? p.displayName,
        portraitUrl: char?.portraitUrl ?? null,
        connected: p.connected,
      });
    }

    // Source 2: all non-NPC characters in the store not already covered
    for (const [id, char] of Object.entries(allChars)) {
      if (!char || (char as any).userId === 'npc' || seen.has(id)) continue;
      seen.add(id);
      const player = charToPlayer[id];
      result.push({
        userId: player?.userId ?? 'unknown',
        characterId: id,
        displayName: player?.displayName ?? char.name,
        characterName: char.name,
        portraitUrl: char.portraitUrl ?? null,
        connected: player?.connected ?? false,
      });
    }

    return result;
  };

  const handleMovePlayersHere = () => {
    // Pass staged positions directly with the activate event so the
    // server can place tokens atomically instead of racing separate
    // token-add events against the migration logic.
    if (hasStaged) {
      const ownerMap = buildOwnerMap();
      const positions = stagedHeroes.map((hero) => ({
        characterId: hero.characterId,
        name: hero.name,
        x: hero.x,
        y: hero.y,
        imageUrl: hero.portraitUrl,
        ownerUserId: ownerMap[hero.characterId] ?? hero.ownerUserId,
      }));
      useMapStore.getState().clearStagedHeroes();
      emitActivateMapForPlayers(currentMap.id, positions);
    } else {
      emitActivateMapForPlayers(currentMap.id);
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: theme.space.lg,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space.md,
        padding: `8px ${theme.space.md}px 8px 10px`,
        borderRadius: theme.radius.md,
        background: 'rgba(24, 20, 14, 0.96)',
        border: `1px solid ${theme.gold.border}`,
        boxShadow: `${theme.shadow.lg}, ${theme.goldGlow.soft}`,
        color: theme.text.primary,
        fontFamily: theme.font.body,
        whiteSpace: 'nowrap' as const,
      }}
    >
      {/* "PREVIEW" chip */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: theme.radius.sm,
          background: theme.gold.bg,
          border: `1px solid ${theme.gold.border}`,
          color: theme.gold.primary,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase' as const,
          boxShadow: theme.goldGlow.soft,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>{EMOJI.map.viewing}</span>
        Preview
      </div>

      {/* Description — single line */}
      <span
        style={{
          fontSize: 12,
          color: theme.text.secondary,
          lineHeight: 1.2,
        }}
      >
        Viewing{' '}
        <strong style={{ color: theme.gold.primary, fontWeight: 600 }}>
          {currentMap.name}
        </strong>
        {' · '}
        Players on{' '}
        <strong style={{ color: theme.text.primary, fontWeight: 600 }}>
          {playerMapSummary?.name ?? 'another map'}
        </strong>
        {playerMapSummary && (
          <span style={{ color: theme.text.muted, fontWeight: 400 }}>
            {' '}({playerMapSummary.tokenCount} token
            {playerMapSummary.tokenCount !== 1 ? 's' : ''})
          </span>
        )}
      </span>

      {/* Actions */}
      <div style={{ display: 'flex', gap: theme.space.sm, flexShrink: 0, marginLeft: theme.space.sm, position: 'relative' }}>
        {playerMapId && (
          <Button variant="ghost" size="sm" onClick={handleJumpToPlayers}>
            Jump to Players
          </Button>
        )}

        {/* Hero staging: dropdown picker for individual heroes */}
        <div style={{ position: 'relative' }}>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<UserPlus size={12} />}
            onClick={() => setShowHeroPicker(!showHeroPicker)}
          >
            {hasStaged ? `Staged (${stagedHeroes.length})` : 'Stage Heroes'}
          </Button>

          {showHeroPicker && (() => {
            const allHeroes = getStageable();
            const stagedIds = new Set(stagedHeroes.map((h) => h.characterId));
            // Show staged heroes first, then un-staged
            const sorted = [
              ...allHeroes.filter((h) => stagedIds.has(h.characterId)),
              ...allHeroes.filter((h) => !stagedIds.has(h.characterId)),
            ];
            return (
              <div
                ref={pickerRef}
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: 6,
                  background: theme.bg.card,
                  border: `1px solid ${theme.gold.border}`,
                  borderRadius: theme.radius.md,
                  boxShadow: theme.shadow.lg,
                  minWidth: 240,
                  zIndex: 100,
                  overflow: 'hidden',
                  whiteSpace: 'normal',
                }}
              >
                <div style={{
                  padding: '8px 12px',
                  borderBottom: `1px solid ${theme.border.default}`,
                  fontSize: 10,
                  fontWeight: 700,
                  color: theme.gold.dim,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                }}>
                  Click to stage / un-stage heroes
                </div>
                {sorted.map((p) => {
                  const isStaged = stagedIds.has(p.characterId);
                  return (
                    <button
                      key={p.characterId}
                      onClick={() => {
                        if (isStaged) {
                          // Un-stage: remove from stagedHeroes
                          const remaining = stagedHeroes.filter((h) => h.characterId !== p.characterId);
                          useMapStore.getState().stageHeroes(remaining);
                        } else {
                          stageHero(p);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '8px 12px',
                        background: isStaged ? 'rgba(232,196,85,0.08)' : 'transparent',
                        border: 'none',
                        borderBottom: `1px solid ${theme.border.default}`,
                        color: theme.text.primary,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: theme.font.body,
                        fontSize: 12,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = isStaged ? 'rgba(232,196,85,0.15)' : theme.bg.hover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = isStaged ? 'rgba(232,196,85,0.08)' : 'transparent'; }}
                    >
                      {/* Staged indicator */}
                      <span style={{
                        width: 18, height: 18, borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, flexShrink: 0,
                        background: isStaged ? theme.gold.bg : theme.bg.elevated,
                        border: `1px solid ${isStaged ? theme.gold.primary : theme.border.default}`,
                        color: isStaged ? theme.gold.primary : theme.text.muted,
                      }}>
                        {isStaged ? '✓' : ''}
                      </span>
                      {p.portraitUrl ? (
                        <img src={p.portraitUrl} alt="" style={{
                          width: 28, height: 28, borderRadius: '50%', objectFit: 'cover',
                          border: `1px solid ${p.connected ? theme.state.success : theme.border.default}`,
                          flexShrink: 0, opacity: isStaged ? 1 : 0.6,
                        }} />
                      ) : (
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: theme.bg.elevated,
                          border: `1px solid ${theme.border.default}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 12, fontWeight: 700, flexShrink: 0, opacity: isStaged ? 1 : 0.6,
                        }}>{p.characterName[0]}</div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, color: isStaged ? theme.gold.primary : theme.text.primary }}>
                          {p.characterName}
                          {isStaged && <span style={{ fontSize: 9, color: theme.state.success, marginLeft: 6 }}>STAGED</span>}
                        </div>
                        <div style={{ fontSize: 9, color: p.connected ? theme.state.success : theme.text.muted }}>
                          {p.connected ? 'Online' : 'Offline'} · {p.displayName}
                          {!isStaged && ' · will land at center'}
                        </div>
                      </div>
                    </button>
                  );
                })}
                {hasStaged && (
                  <button
                    onClick={() => { useMapStore.getState().clearStagedHeroes(); }}
                    style={{
                      width: '100%', padding: '8px 12px',
                      background: theme.state.dangerBg,
                      border: 'none', borderTop: `1px solid ${theme.border.default}`,
                      color: theme.state.danger,
                      fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      fontFamily: theme.font.body, textAlign: 'center',
                    }}
                  >
                    Clear All Staged
                  </button>
                )}
              </div>
            );
          })()}
        </div>

        <Button variant="primary" size="sm" onClick={handleMovePlayersHere}>
          Move Players Here
        </Button>
      </div>

      {/* Dismiss */}
      <button
        onClick={() => setDismissedForMapId(currentMap.id)}
        title="Dismiss (banner returns if you preview a different map)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          padding: 0,
          background: 'transparent',
          border: `1px solid ${theme.border.default}`,
          borderRadius: 4,
          color: theme.text.muted,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = theme.gold.primary;
          e.currentTarget.style.borderColor = theme.gold.primary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = theme.text.muted;
          e.currentTarget.style.borderColor = theme.border.default;
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
