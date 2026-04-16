import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useSceneStore } from '../../stores/useSceneStore';
import { useMapStore } from '../../stores/useMapStore';
import {
  emitListMaps, emitPreviewLoadMap, emitActivateMapForPlayers, emitDeleteMap,
  emitRenameMap, emitDuplicateMap, emitReorderMaps,
} from '../../socket/emitters';
import { getMapThumbnail } from '../../utils/prebuiltMapImages';
import { Section, Card, Badge, Button } from '../ui';
import type { MapSummary } from '@dnd-vtt/shared';

/**
 * Scene Manager sidebar — the DM's view of every map in the session.
 * Shows the player ribbon, the DM's current preview, and lets the DM
 * click to preview, move the ribbon, rename, duplicate, delete, or
 * drag to reorder.
 *
 * Sort order is fully DM-controlled via display_order on the map row.
 * The earlier "ribbon-first auto-sort" behaviour is gone — the badge +
 * accent bar still make the ribbon obvious, but the DM decides where
 * each scene sits in the sidebar.
 */
export function SceneManager() {
  const maps = useSceneStore((s) => s.maps);
  const loaded = useSceneStore((s) => s.loaded);
  const currentMap = useMapStore((s) => s.currentMap);
  const playerMapId = useMapStore((s) => s.playerMapId);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Inline filter for sessions with a long scene list. Filters by name
  // substring (case-insensitive) so the DM doesn't have to scroll through
  // 25+ scenes during a long-running campaign.
  const [searchInput, setSearchInput] = useState('');
  // Optimistic local order — when the DM drags, we reorder this
  // immediately and emit; the server's broadcast then confirms / corrects.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);

  useEffect(() => { emitListMaps(); }, [playerMapId]);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  // Whenever the canonical map list changes (server broadcast), drop
  // any stale optimistic order. The new sort comes straight from the
  // server's display_order ranking.
  useEffect(() => { setOptimisticOrder(null); }, [maps]);

  const sortedMaps = useMemo<MapSummary[]>(() => {
    const base = [...maps].sort((a, b) => {
      const da = a.displayOrder ?? 0;
      const db = b.displayOrder ?? 0;
      if (da !== db) return da - db;
      // Tiebreaker on createdAt so two zero-order legacy rows still
      // come out in a deterministic order.
      return a.createdAt.localeCompare(b.createdAt);
    });
    if (!optimisticOrder) return base;
    const idx = new Map(optimisticOrder.map((id, i) => [id, i]));
    return [...base].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
  }, [maps, optimisticOrder]);

  // Apply the search filter on top of sortedMaps so reordering still
  // respects the DM's display_order — search just hides non-matching
  // rows. Matching is case-insensitive substring on the scene name.
  const visibleMaps = useMemo<MapSummary[]>(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return sortedMaps;
    return sortedMaps.filter((m) => m.name.toLowerCase().includes(q));
  }, [sortedMaps, searchInput]);

  const handlePreview = (mapId: string) => {
    if (mapId === currentMap?.id) return;
    if (renamingId) return; // don't preview while editing the name
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

  const handleDuplicate = (e: React.MouseEvent, mapId: string) => {
    e.stopPropagation();
    emitDuplicateMap(mapId);
  };

  const handleStartRename = (e: React.MouseEvent, m: MapSummary) => {
    e.stopPropagation();
    setRenamingId(m.id);
    setRenameDraft(m.name);
  };

  const commitRename = (mapId: string) => {
    const draft = renameDraft.trim();
    if (draft && draft.length <= 80) {
      const original = maps.find((m) => m.id === mapId)?.name;
      if (draft !== original) emitRenameMap(mapId, draft);
    }
    setRenamingId(null);
    setRenameDraft('');
  };

  // --- Drag-to-reorder (HTML5 native, no extra dependency) ---

  const handleDragStart = (e: React.DragEvent, mapId: string) => {
    setDragId(mapId);
    e.dataTransfer.effectAllowed = 'move';
    // Firefox needs SOMETHING in the data transfer or drag never fires.
    e.dataTransfer.setData('text/plain', mapId);
  };

  const handleDragOver = (e: React.DragEvent, mapId: string) => {
    if (!dragId || dragId === mapId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropTargetId !== mapId) setDropTargetId(mapId);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId) {
      setDragId(null); setDropTargetId(null); return;
    }
    const ids = sortedMaps.map((m) => m.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDragId(null); setDropTargetId(null); return;
    }
    const next = ids.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragId);
    setOptimisticOrder(next);
    emitReorderMaps(next);
    setDragId(null);
    setDropTargetId(null);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDropTargetId(null);
  };

  const handleAddMap = () => {
    window.dispatchEvent(new CustomEvent('open-map-browser'));
  };

  // Show count alongside the section title so the DM can tell at a
  // glance how many scenes are in the session, and how many of those
  // match the current search filter.
  const totalCount = sortedMaps.length;
  const visibleCount = visibleMaps.length;
  const titleSuffix = searchInput && visibleCount !== totalCount
    ? ` (${visibleCount} of ${totalCount})`
    : totalCount > 0 ? ` (${totalCount})` : '';

  return (
    <Section
      title={`Scenes${titleSuffix}`}
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

      {/* Inline scene search — only render when there are enough scenes
          to make scrolling tedious. Below 6 the input is more clutter
          than it's worth. */}
      {loaded && totalCount >= 6 && (
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Filter scenes by name..."
          aria-label="Filter scenes"
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 12,
            color: theme.text.primary,
            background: theme.bg.deep,
            border: `1px solid ${theme.border.default}`,
            borderRadius: theme.radius.sm,
            outline: 'none',
            boxSizing: 'border-box' as const,
          }}
        />
      )}

      {visibleMaps.map((map) => {
        const isRibbon = map.id === playerMapId;
        const isDmView = map.id === currentMap?.id;
        const imgSrc = getMapThumbnail(map);
        const isPendingDelete = pendingDeleteId === map.id;
        const isRenaming = renamingId === map.id;
        const isDropTarget = dropTargetId === map.id && dragId !== map.id;
        const isDragging = dragId === map.id;
        const gridCols = Math.round(map.width / map.gridSize);
        const gridRows = Math.round(map.height / map.gridSize);

        return (
          <div
            key={map.id}
            draggable={!isRenaming}
            onDragStart={(e) => handleDragStart(e, map.id)}
            onDragOver={(e) => handleDragOver(e, map.id)}
            onDrop={(e) => handleDrop(e, map.id)}
            onDragEnd={handleDragEnd}
            style={{
              opacity: isDragging ? 0.4 : 1,
              outline: isDropTarget ? `2px dashed ${theme.state.success ?? '#27ae60'}` : 'none',
              borderRadius: theme.radius.sm,
              transition: 'outline-color 80ms linear, opacity 80ms linear',
            }}
          >
          <Card
            accentBar={isRibbon ? 'bright-gold' : isDmView ? 'gold' : 'none'}
            highlighted={isRibbon || isDmView}
            glow={isRibbon}
            interactive
            padding="none"
            onClick={() => handlePreview(map.id)}
            title={isDmView ? 'Currently viewing' : 'Click to preview · drag to reorder'}
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
                  {isRenaming ? (
                    <RenameInput
                      initial={renameDraft}
                      onChange={setRenameDraft}
                      onCommit={() => commitRename(map.id)}
                      onCancel={() => { setRenamingId(null); setRenameDraft(''); }}
                    />
                  ) : (
                    <span
                      style={{
                        ...theme.type.h2,
                        color: theme.text.primary,
                        whiteSpace: 'nowrap' as const,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis' as const,
                        minWidth: 0,
                        flex: 1,
                        cursor: 'text',
                      }}
                      onDoubleClick={(e) => handleStartRename(e, map)}
                      title="Double-click to rename"
                    >
                      {map.name}
                    </span>
                  )}
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
                  {/* Surface wall / zone counts so the DM can spot
                      prep gaps — a combat map with 0 walls usually
                      means line-of-sight isn't set up. We only render
                      the chunk when the count is non-zero so blank
                      scenes stay tidy. */}
                  {map.wallCount > 0 && (
                    <> · {map.wallCount} wall{map.wallCount !== 1 ? 's' : ''}</>
                  )}
                  {map.zoneCount > 0 && (
                    <> · {map.zoneCount} zone{map.zoneCount !== 1 ? 's' : ''}</>
                  )}
                </div>

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
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => handleDuplicate(e, map.id)}
                          title="Duplicate this map (walls + zones, no tokens)"
                        >
                          Duplicate
                        </Button>
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
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>
          </div>
        );
      })}
    </Section>
  );
}

/**
 * Inline rename input. Auto-focuses + selects on mount, commits on
 * Enter or blur, cancels on Escape. Stops propagation so click into
 * the field doesn't trigger the card's preview.
 */
function RenameInput({
  initial, onChange, onCommit, onCancel,
}: {
  initial: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      value={initial}
      maxLength={80}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      style={{
        ...theme.type.h2,
        color: theme.text.primary,
        background: theme.bg.deep,
        border: `1px solid ${theme.border.default}`,
        borderRadius: theme.radius.sm,
        padding: '2px 6px',
        flex: 1,
        minWidth: 0,
        outline: 'none',
      }}
    />
  );
}
