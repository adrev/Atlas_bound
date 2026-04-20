import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { useSceneStore } from '../../stores/useSceneStore';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
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
  const folders = useSceneStore((s) => s.folders);
  const setFolders = useSceneStore((s) => s.setFolders);
  const addFolderLocal = useSceneStore((s) => s.addFolder);
  const renameFolderLocal = useSceneStore((s) => s.renameFolder);
  const removeFolderLocal = useSceneStore((s) => s.removeFolder);
  const moveMapLocal = useSceneStore((s) => s.moveMapToFolder);
  const loaded = useSceneStore((s) => s.loaded);
  const currentMap = useMapStore((s) => s.currentMap);
  const playerMapId = useMapStore((s) => s.playerMapId);
  const sessionId = useSessionStore((s) => s.sessionId);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState('');
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

  // Folders live on the REST surface (server/routes/maps.ts) rather
  // than the socket — folder ops are rare compared to token moves so
  // they don't justify socket plumbing. Fetch once per session; the
  // client-local store handles optimistic updates.
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/map-folders`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; session_id: string; sessionId?: string; name: string; display_order?: number; displayOrder?: number; created_at?: string; createdAt?: string }>) => {
        setFolders(rows.map((r) => ({
          id: r.id,
          sessionId: r.sessionId ?? r.session_id,
          name: r.name,
          displayOrder: r.displayOrder ?? r.display_order ?? 0,
          createdAt: r.createdAt ?? r.created_at ?? '',
        })));
      })
      .catch(() => { /* ignore — fresh session, empty list is fine */ });
  }, [sessionId, setFolders]);

  const handleNewFolder = async () => {
    if (!sessionId) return;
    const name = window.prompt('Folder name (e.g. "Act II", "Waterdeep dungeons")');
    if (!name || !name.trim()) return;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/map-folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const folder = await resp.json();
      addFolderLocal({
        id: folder.id,
        sessionId: folder.sessionId,
        name: folder.name,
        displayOrder: folder.displayOrder ?? 0,
        createdAt: new Date().toISOString(),
      });
    } catch {
      setError('Failed to create folder.');
    }
  };

  const handleRenameFolder = async (folderId: string) => {
    const name = folderRenameDraft.trim();
    setRenamingFolderId(null);
    setFolderRenameDraft('');
    if (!name) return;
    try {
      await fetch(`/api/map-folders/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        credentials: 'include',
      });
      renameFolderLocal(folderId, name);
    } catch { /* ignore */ }
  };

  const handleDeleteFolder = async (folderId: string) => {
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return;
    if (!window.confirm(`Delete folder "${folder.name}"? Maps inside will move to the root.`)) return;
    try {
      await fetch(`/api/map-folders/${folderId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      removeFolderLocal(folderId);
    } catch { /* ignore */ }
  };

  const handleMoveMap = async (mapId: string, folderId: string | null) => {
    setMoveMenuFor(null);
    try {
      await fetch(`/api/maps/${mapId}/folder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
        credentials: 'include',
      });
      moveMapLocal(mapId, folderId);
    } catch { /* ignore */ }
  };

  const toggleFolder = (id: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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

  // Partition visible maps into folder buckets (including a "null"
  // bucket for anything without a folder). Sorted folder list drives
  // render order; the null bucket always renders first so "unfiled"
  // scenes stay at the top of the DM's eye line.
  const mapsByFolder = useMemo(() => {
    const buckets = new Map<string | null, MapSummary[]>();
    for (const m of visibleMaps) {
      const key = m.folderId ?? null;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(m);
    }
    return buckets;
  }, [visibleMaps]);

  const sortedFolders = useMemo(
    () => [...folders].sort((a, b) =>
      a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
    [folders],
  );

  return (
    <Section
      title={`Scenes${titleSuffix}`}
      emoji={EMOJI.map.scene}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={handleNewFolder} title="Create folder">
            📁 +
          </Button>
          <Button size="sm" variant="primary" onClick={handleAddMap}>
            + Add Map
          </Button>
        </div>
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

      {/* Unfiled maps render first so "no folder" scenes stay at the
          top of the eye line; then each folder gets its own collapsible
          section. Each bucket renders via the same inline loop so
          maintenance stays in one place. */}
      {(() => {
        const renderMap = (map: MapSummary) => {
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
                      position: 'relative',
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
                    {/* Per-card folder selector. Compact dropdown shows
                        every folder + a "Move to root" option. Using a
                        click-outside close would be over-engineering
                        for a single menu; stopPropagation on the
                        button keeps the card's own onClick from
                        swallowing the toggle. */}
                    <div style={{ position: 'relative', marginLeft: 'auto' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoveMenuFor((prev) => (prev === map.id ? null : map.id));
                        }}
                        title="Move to folder"
                      >
                        📁
                      </Button>
                      {moveMenuFor === map.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            position: 'absolute',
                            top: '100%',
                            right: 0,
                            marginTop: 4,
                            minWidth: 160,
                            maxHeight: 220,
                            overflowY: 'auto',
                            padding: 4,
                            background: theme.bg.card,
                            border: `1px solid ${theme.gold.border}`,
                            borderRadius: 6,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.55)',
                            zIndex: 30,
                          }}
                        >
                          <div style={{
                            fontSize: 9, textTransform: 'uppercase' as const,
                            letterSpacing: '0.08em', color: theme.text.muted,
                            padding: '4px 8px',
                          }}>
                            Move to
                          </div>
                          <button
                            onClick={() => handleMoveMap(map.id, null)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left' as const,
                              padding: '5px 10px', fontSize: 11, fontWeight: 600,
                              background: map.folderId === null ? theme.gold.bg : 'transparent',
                              color: theme.text.primary, border: 'none', cursor: 'pointer',
                              fontFamily: 'inherit', borderRadius: 3,
                            }}
                          >
                            (Root)
                          </button>
                          {sortedFolders.map((f) => (
                            <button
                              key={f.id}
                              onClick={() => handleMoveMap(map.id, f.id)}
                              style={{
                                display: 'block', width: '100%', textAlign: 'left' as const,
                                padding: '5px 10px', fontSize: 11, fontWeight: 600,
                                background: map.folderId === f.id ? theme.gold.bg : 'transparent',
                                color: theme.text.primary, border: 'none', cursor: 'pointer',
                                fontFamily: 'inherit', borderRadius: 3,
                              }}
                            >
                              📁 {f.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
          </div>
        );
        };

        const rootBucket = mapsByFolder.get(null) ?? [];
        return (
          <>
            {rootBucket.map(renderMap)}
            {sortedFolders.map((folder) => {
              const bucket = mapsByFolder.get(folder.id) ?? [];
              if (bucket.length === 0 && !folders.some((f) => f.id === folder.id)) return null;
              const collapsed = collapsedFolders.has(folder.id);
              const isRenamingThis = renamingFolderId === folder.id;
              return (
                <div key={folder.id} style={{ marginTop: theme.space.sm }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 8px',
                      background: theme.bg.deep,
                      border: `1px solid ${theme.border.default}`,
                      borderRadius: theme.radius.sm,
                      cursor: 'pointer',
                      marginBottom: 4,
                    }}
                    onClick={() => toggleFolder(folder.id)}
                  >
                    <span style={{ fontSize: 11 }}>{collapsed ? '▸' : '▾'}</span>
                    <span style={{ fontSize: 14, lineHeight: 1 }}>📁</span>
                    {isRenamingThis ? (
                      <input
                        type="text"
                        autoFocus
                        value={folderRenameDraft}
                        onChange={(e) => setFolderRenameDraft(e.target.value)}
                        onBlur={() => handleRenameFolder(folder.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') { setRenamingFolderId(null); setFolderRenameDraft(''); }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          flex: 1, padding: '2px 6px', fontSize: 12,
                          background: theme.bg.base, color: theme.text.primary,
                          border: `1px solid ${theme.gold.border}`, borderRadius: 3,
                          outline: 'none',
                        }}
                      />
                    ) : (
                      <span
                        style={{ fontSize: 12, fontWeight: 600, color: theme.text.primary, flex: 1 }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingFolderId(folder.id);
                          setFolderRenameDraft(folder.name);
                        }}
                        title="Double-click to rename"
                      >
                        {folder.name}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: theme.text.muted }}>
                      {bucket.length}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id); }}
                      title="Delete folder (maps go to root)"
                      style={{
                        marginLeft: 4,
                        padding: '2px 6px',
                        fontSize: 10,
                        background: 'transparent',
                        color: theme.text.muted,
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {!collapsed && bucket.map(renderMap)}
                </div>
              );
            })}
          </>
        );
      })()}
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
