import { useEffect, useMemo, useState } from 'react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useSceneStore } from '../../stores/useSceneStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitListMaps, emitPreviewLoadMap, emitActivateMapForPlayers, emitDeleteMap,
} from '../../socket/emitters';
import { getMapThumbnail } from '../../utils/prebuiltMapImages';
import { Section, Card, Badge, Button } from '../ui';

/**
 * Scene Manager sidebar — the DM's view of every map in the session.
 * Shows the player ribbon, the DM's current preview, and lets the DM
 * click to preview, move the ribbon, or delete.
 *
 * Rewritten for the UI unification pass to use shared primitives:
 *   • Section — unified section header + action slot
 *   • Card + accentBar — scene cards with yellow ribbon / gold DM-view highlight
 *   • Badge — PLAYERS / VIEWING indicators
 *   • Button — Move Players Here / Delete actions
 */
export function SceneManager() {
  const maps = useSceneStore((s) => s.maps);
  const loaded = useSceneStore((s) => s.loaded);
  const currentMap = useMapStore((s) => s.currentMap);
  const playerMapId = useMapStore((s) => s.playerMapId);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch the scene list whenever the manager is mounted (DM opened
  // the tab) AND whenever the ribbon moves so we pick up new maps
  // added by other clients.
  useEffect(() => {
    emitListMaps();
  }, [playerMapId]);

  // Auto-clear transient errors after a few seconds
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  // Sort maps: player ribbon first, then DM's current view, then others
  const sortedMaps = useMemo(() => {
    const currentViewId = currentMap?.id ?? null;
    return [...maps].sort((a, b) => {
      if (a.id === playerMapId) return -1;
      if (b.id === playerMapId) return 1;
      if (a.id === currentViewId) return -1;
      if (b.id === currentViewId) return 1;
      return 0;
    });
  }, [maps, playerMapId, currentMap?.id]);

  const handlePreview = (mapId: string) => {
    if (mapId === currentMap?.id) return;
    emitPreviewLoadMap(mapId);
  };

  const handleActivate = (e: React.MouseEvent, mapId: string) => {
    e.stopPropagation();
    emitActivateMapForPlayers(mapId);
  };

  const handleDelete = (e: React.MouseEvent, mapId: string) => {
    e.stopPropagation();
    if (pendingDeleteId === mapId) {
      if (mapId === playerMapId) {
        setError("Can't delete the map the players are on — move the ribbon first.");
        setPendingDeleteId(null);
        return;
      }
      emitDeleteMap(mapId);
      setPendingDeleteId(null);
    } else {
      setPendingDeleteId(mapId);
      window.setTimeout(
        () => setPendingDeleteId((id) => (id === mapId ? null : id)),
        3000,
      );
    }
  };

  const handleAddMap = () => {
    window.dispatchEvent(new CustomEvent('open-map-browser'));
  };

  return (
    <Section
      title="Scenes"
      emoji={EMOJI.map.scene}
      action={
        <Button size="sm" variant="primary" onClick={handleAddMap}>
          + Add Map
        </Button>
      }
      spacing="compact"
    >
      {error && (
        <div
          style={{
            padding: `${theme.space.sm}px ${theme.space.lg}px`,
            borderRadius: theme.radius.sm,
            background: theme.state.dangerBg,
            border: `1px solid rgba(192, 57, 43, 0.4)`,
            color: theme.state.danger,
            ...theme.type.small,
            fontWeight: 500,
          }}
        >
          {error}
        </div>
      )}

      {/* Empty state */}
      {loaded && maps.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: theme.space.md,
            padding: `${theme.space.xxl}px ${theme.space.lg}px`,
            textAlign: 'center' as const,
          }}
        >
          <div style={{ fontSize: 32, opacity: 0.6 }}>{EMOJI.map.scene}</div>
          <p style={{ margin: 0, ...theme.type.small, color: theme.text.muted }}>
            No maps in this session yet.
          </p>
          <Button variant="primary" size="md" onClick={handleAddMap}>
            + Add your first map
          </Button>
        </div>
      )}

      {/* Loading state */}
      {!loaded && (
        <div
          style={{
            padding: theme.space.lg,
            ...theme.type.small,
            color: theme.text.muted,
            textAlign: 'center' as const,
          }}
        >
          Loading scenes...
        </div>
      )}

      {/* Scene cards */}
      {sortedMaps.map((map) => {
        const isRibbon = map.id === playerMapId;
        const isDmView = map.id === currentMap?.id;
        const imgSrc = getMapThumbnail(map);
        const isPendingDelete = pendingDeleteId === map.id;
        const gridCols = Math.round(map.width / map.gridSize);
        const gridRows = Math.round(map.height / map.gridSize);

        return (
          <Card
            key={map.id}
            accentBar={isRibbon ? 'bright-gold' : isDmView ? 'gold' : 'none'}
            highlighted={isRibbon || isDmView}
            glow={isRibbon}
            interactive
            padding="none"
            onClick={() => handlePreview(map.id)}
            title={isDmView ? 'Currently viewing' : 'Click to preview'}
          >
            <div
              style={{
                display: 'flex',
                gap: theme.space.md,
                padding: `${theme.space.sm}px ${theme.space.md}px ${theme.space.sm}px ${
                  theme.space.md + 4
                }px`,
              }}
            >
              {/* Thumbnail */}
              <div
                style={{
                  width: 68,
                  height: 46,
                  borderRadius: theme.radius.sm,
                  overflow: 'hidden' as const,
                  flexShrink: 0,
                  background: theme.bg.deep,
                  border: `1px solid ${theme.border.default}`,
                }}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={map.name}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                      color: theme.text.muted,
                    }}
                  >
                    {EMOJI.map.scene}
                  </div>
                )}
              </div>

              {/* Body */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: theme.space.sm,
                  }}
                >
                  <span
                    style={{
                      ...theme.type.h2,
                      color: theme.text.primary,
                      whiteSpace: 'nowrap' as const,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis' as const,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {map.name}
                  </span>
                  <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                    {isRibbon && (
                      <Badge variant="bright" size="sm" emoji={EMOJI.map.ribbon} glow>
                        PLAYERS
                      </Badge>
                    )}
                    {isDmView && !isRibbon && (
                      <Badge variant="gold" size="sm" emoji={EMOJI.map.viewing}>
                        VIEWING
                      </Badge>
                    )}
                  </div>
                </div>
                <div style={{ ...theme.type.micro, color: theme.text.muted }}>
                  {gridCols}×{gridRows} · {map.tokenCount} token
                  {map.tokenCount !== 1 ? 's' : ''}
                </div>

                {/* Actions: always show Move Players Here on non-ribbon
                    cards, Delete only on the DM's current view to avoid
                    sidebar clutter. */}
                {(!isRibbon || isDmView) && (
                  <div
                    style={{
                      display: 'flex',
                      gap: theme.space.xs,
                      marginTop: theme.space.xs,
                    }}
                  >
                    {!isRibbon && (
                      <Button
                        size="sm"
                        variant="primary"
                        fullWidth
                        onClick={(e) => handleActivate(e, map.id)}
                        title="Send the party to this map (their tokens will follow)"
                      >
                        Move Players Here
                      </Button>
                    )}
                    {isDmView && (
                      <Button
                        size="sm"
                        variant={isPendingDelete ? 'danger' : 'ghost'}
                        onClick={(e) => handleDelete(e, map.id)}
                        disabled={isRibbon}
                        title={
                          isRibbon
                            ? 'Move the ribbon first before deleting'
                            : isPendingDelete
                              ? 'Click again to confirm'
                              : 'Delete map'
                        }
                      >
                        {isPendingDelete ? 'Confirm' : 'Delete'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </Section>
  );
}
