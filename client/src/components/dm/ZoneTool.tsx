import { useCallback, useMemo, useState } from 'react';
import { Rect, Text, Group } from 'react-konva';
import type Konva from 'konva';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitZoneAdd, emitZoneDelete } from '../../socket/emitters';
import { askConfirm, askPrompt } from '../ui';
import { theme } from '../../styles/theme';

/**
 * Encounter-spawn zones: named rectangular regions a DM draws on a map.
 * The EncounterBuilder can then drop an encounter INTO a specific zone
 * instead of dumping creatures at map center.
 *
 *  ZoneControls  – sidebar panel shown when the zone tool is active
 *  ZoneLayer     – Konva layer; renders existing zones + draws new ones
 *
 * Zones are DM-only. Players never see them or receive zone events.
 */

// ------------------------------------------------------------------ UI

export function ZoneControls() {
  const isDM = useSessionStore((s) => s.isDM);
  const activeTool = useMapStore((s) => s.activeTool);
  const zones = useMapStore((s) => s.zones);

  if (!isDM || activeTool !== 'zone') return null;

  return (
    <div style={styles.container}>
      <div style={styles.header}>Encounter Zones</div>
      <div style={styles.instructions}>
        Click and drag on the map to draw a spawn zone. Name it when prompted.
        Deploy an encounter with the zone selected to scatter tokens inside it.
      </div>
      <div style={styles.zoneCount}>
        {zones.length} zone{zones.length === 1 ? '' : 's'} on this map
      </div>
      {zones.length > 0 && (
        <div style={styles.zoneList}>
          {zones.map((z) => (
            <div key={z.id} style={styles.zoneItem}>
              <span style={styles.zoneName}>{z.name}</span>
              <span style={styles.zoneMeta}>
                {Math.round(z.width)}x{Math.round(z.height)}
              </span>
              <button
                style={styles.deleteButton}
                onClick={() => emitZoneDelete(z.id)}
                title="Delete zone"
              >
                X
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- Layer

interface DragState {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export function ZoneLayer() {
  const isDM = useSessionStore((s) => s.isDM);
  const activeTool = useMapStore((s) => s.activeTool);
  const zones = useMapStore((s) => s.zones);
  const currentMap = useMapStore((s) => s.currentMap);
  const [drag, setDrag] = useState<DragState | null>(null);

  const isZoneTool = activeTool === 'zone';

  const normalize = useMemo(() => (d: DragState) => ({
    x: Math.min(d.startX, d.x),
    y: Math.min(d.startY, d.y),
    width: Math.abs(d.x - d.startX),
    height: Math.abs(d.y - d.startY),
  }), []);

  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!isZoneTool) return;
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!stage || !pos) return;
    // Convert screen to stage coordinates (account for viewport).
    const transform = stage.getAbsoluteTransform().copy().invert();
    const { x, y } = transform.point(pos);
    setDrag({ startX: x, startY: y, x, y });
  }, [isZoneTool]);

  const handleMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!drag) return;
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!stage || !pos) return;
    const transform = stage.getAbsoluteTransform().copy().invert();
    const { x, y } = transform.point(pos);
    setDrag((d) => (d ? { ...d, x, y } : d));
  }, [drag]);

  const handleMouseUp = useCallback(() => {
    if (!drag) return;
    const { x, y, width, height } = normalize(drag);
    setDrag(null);
    if (width < 20 || height < 20) return; // ignore noise clicks
    void (async () => {
      const name = await askPrompt({
        title: 'Name this zone',
        message: 'A short label the DM sees on the map and in the spawn dropdown.',
        defaultValue: 'Spawn zone',
        placeholder: 'e.g. North ambush',
        maxLength: 64,
      });
      if (!name) return;
      emitZoneAdd({ name, x, y, width, height });
    })();
  }, [drag, normalize]);

  // Only DMs ever see this layer; players never receive zone updates.
  if (!isDM) return null;

  return (
    <Group
      listening={isZoneTool}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Transparent hit Rect covering the whole map. Without this,
          mouse-downs on empty map space target the Stage instead of
          this layer \u2014 so the drag to draw a new zone wouldn't fire.
          The rect is invisible (opacity 0) but catches all pointer
          events while the zone tool is active. */}
      {isZoneTool && currentMap && (
        <Rect
          x={0}
          y={0}
          width={currentMap.width}
          height={currentMap.height}
          fill="rgba(0,0,0,0.001)"
          listening
        />
      )}
      {zones.map((z) => (
        <Group key={z.id}>
          <Rect
            x={z.x}
            y={z.y}
            width={z.width}
            height={z.height}
            stroke={theme.gold.primary}
            strokeWidth={2}
            dash={[10, 6]}
            fill={'rgba(232, 196, 85, 0.08)'}
            listening={false}
          />
          {/* Clickable label that deletes the zone (DM only). Right-click
              also deletes; standard left-click confirms via window prompt. */}
          <Group
            x={z.x + 4}
            y={z.y + 4}
            onClick={() => {
              void askConfirm({
                title: 'Delete zone',
                message: `Delete zone \u201C${z.name}\u201D?`,
                tone: 'danger',
                confirmLabel: 'Delete',
              }).then((ok) => { if (ok) emitZoneDelete(z.id); });
            }}
            onContextMenu={(e) => {
              e.evt.preventDefault();
              emitZoneDelete(z.id);
            }}
          >
            <Rect
              width={Math.min(z.name.length * 8 + 16, 220)}
              height={20}
              fill="rgba(0,0,0,0.55)"
              cornerRadius={4}
              stroke={theme.gold.primary}
              strokeWidth={1}
            />
            <Text
              x={6}
              y={4}
              text={`🎯 ${z.name}`}
              fontSize={12}
              fontStyle="bold"
              fill={theme.gold.primary}
              listening={false}
            />
          </Group>
        </Group>
      ))}

      {drag && (() => {
        const r = normalize(drag);
        return (
          <Rect
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            stroke={theme.gold.primary}
            strokeWidth={2}
            dash={[6, 4]}
            fill={'rgba(232, 196, 85, 0.18)'}
            listening={false}
          />
        );
      })()}
    </Group>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 0',
  },
  header: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  instructions: {
    fontSize: 12,
    color: theme.text.muted,
    lineHeight: '1.4',
  },
  zoneCount: {
    fontSize: 12,
    color: theme.text.secondary,
    padding: '4px 8px',
    background: theme.bg.deep,
    borderRadius: theme.radius.sm,
  },
  zoneList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 200,
    overflowY: 'auto',
  },
  zoneItem: {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    gap: 6,
    alignItems: 'center',
    padding: '4px 8px',
    background: theme.bg.deep,
    borderRadius: theme.radius.sm,
    fontSize: 12,
  },
  zoneName: {
    color: theme.text.primary,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  zoneMeta: {
    color: theme.text.muted,
    fontFamily: 'monospace',
    fontSize: 10,
  },
  deleteButton: {
    padding: '2px 6px',
    border: 'none',
    borderRadius: theme.radius.sm,
    background: 'rgba(192, 57, 43, 0.3)',
    color: theme.danger,
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 'bold',
    fontFamily: theme.font.body,
  },
};
