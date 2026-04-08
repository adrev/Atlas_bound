import { useState, useEffect } from 'react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { useDrawStore } from '../../stores/useDrawStore';
import {
  emitPing, emitTokenAdd, emitStartCombat, emitEndCombat,
  emitDrawingClearAll,
} from '../../socket/emitters';

const C = {
  bg: '#1a1a1a', bgHover: '#2a2a2a', border: '#444',
  text: '#eee', textMuted: '#777', red: '#c53131', gold: '#d4a843',
};

interface MenuState {
  screenX: number;
  screenY: number;
  mapX: number;
  mapY: number;
}

export function MapContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const isDM = useSessionStore((s) => s.isDM);
  const combatActive = useCombatStore((s) => s.active);
  const tokens = useMapStore((s) => s.tokens);
  const currentMap = useMapStore((s) => s.currentMap);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        setMenu({
          screenX: detail.screenX,
          screenY: detail.screenY,
          mapX: detail.mapX,
          mapY: detail.mapY,
        });
      }
    };
    window.addEventListener('map-context-menu', handler);
    return () => window.removeEventListener('map-context-menu', handler);
  }, []);

  if (!menu) return null;

  const close = () => setMenu(null);

  const menuX = Math.min(menu.screenX, (typeof window !== 'undefined' ? window.innerWidth - 220 : 600));
  const menuY = Math.min(menu.screenY, (typeof window !== 'undefined' ? window.innerHeight - 300 : 400));

  return (
    <>
      {/* Backdrop */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={e => { e.stopPropagation(); e.preventDefault(); close(); }}
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        onMouseUp={e => e.stopPropagation()}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close(); }}
      />

      {/* Menu */}
      <div
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        style={{
          position: 'fixed', left: menuX, top: menuY, zIndex: 9999,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)', minWidth: 200,
          fontFamily: '-apple-system, sans-serif', fontSize: 13, color: C.text,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.textMuted }}>
          Map ({Math.round(menu.mapX)}, {Math.round(menu.mapY)})
        </div>

        {/* Ping */}
        <Item icon="📡" label="Ping Here" onClick={() => { emitPing(menu.mapX, menu.mapY); close(); }} />

        {/* Paste Token */}
        {isDM && useMapStore.getState().copiedToken && (
          <Item icon="📋" label={`Paste ${useMapStore.getState().copiedToken!.name}`} onClick={() => {
            const copied = useMapStore.getState().copiedToken;
            if (!copied || !currentMap) { close(); return; }
            emitTokenAdd({
              mapId: currentMap.id,
              characterId: copied.characterId,
              name: copied.name,
              x: menu.mapX,
              y: menu.mapY,
              size: copied.size,
              imageUrl: copied.imageUrl,
              color: copied.color,
              layer: copied.layer,
              visible: copied.visible,
              hasLight: copied.hasLight,
              lightRadius: copied.lightRadius,
              lightDimRadius: copied.lightDimRadius,
              lightColor: copied.lightColor,
              conditions: [],
              ownerUserId: null,
            });
            close();
          }} />
        )}

        {/* Measure */}
        <Item icon="📏" label="Measure From Here" onClick={() => {
          useMapStore.getState().setTool('measure');
          close();
        }} />

        {/* Draw Mode — available to everyone. Players get a personal
            draw layer (visible to them + DM); DMs get the full toolbar
            with shared / dm-only / personal visibility options. */}
        <Item icon="✏️" label="Draw Mode" onClick={() => {
          useDrawStore.getState().enterDrawMode();
          close();
        }} />

        {isDM && (
          <>
            <div style={{ height: 1, background: C.border, margin: '2px 0' }} />

            {/* Wall drawing */}
            <Item icon="🧱" label="Draw Walls" onClick={() => {
              useMapStore.getState().setTool('wall');
              close();
            }} />

            {/* Clear all drawings on the current map (DM only) */}
            <Item icon="🗑️" label="Clear All Drawings" onClick={() => {
              // eslint-disable-next-line no-alert
              if (confirm('Clear all drawings on this map? This cannot be undone.')) {
                emitDrawingClearAll('all');
              }
              close();
            }} />

            {/* Quick place token */}
            <Item icon="👤" label="Place Token Here" onClick={() => {
              if (!currentMap) { close(); return; }
              emitTokenAdd({
                mapId: currentMap.id,
                characterId: null,
                name: 'Token',
                x: menu.mapX,
                y: menu.mapY,
                size: 1,
                imageUrl: null,
                color: '#e74c3c',
                layer: 'token',
                visible: true,
                hasLight: false,
                lightRadius: 0,
                lightDimRadius: 0,
                lightColor: '#ffcc44',
                conditions: [],
                ownerUserId: null,
              });
              close();
            }} />

            {/* Open creature library */}
            <Item icon="🐉" label="Spawn Creature Here" onClick={() => {
              window.dispatchEvent(new Event('open-creature-library'));
              close();
            }} />

            <div style={{ height: 1, background: C.border, margin: '2px 0' }} />

            {/* Combat */}
            {!combatActive && Object.keys(tokens).length > 0 && (
              <Item icon="⚔️" label="Start Combat" onClick={() => { emitStartCombat(Object.keys(tokens)); close(); }} />
            )}
            {combatActive && (
              <Item icon="🏳️" label="End Combat" onClick={() => { emitEndCombat(); close(); }} />
            )}
          </>
        )}

        <div style={{ height: 1, background: C.border, margin: '2px 0' }} />

        {/* Center view — dispatch the canvas-center-on event so BattleMap
            updates its local viewport. (The useMapStore.viewport field
            is a stale leftover; the real viewport lives in the
            useCanvasViewport hook.) */}
        <Item icon="🔍" label="Center View Here" onClick={() => {
          window.dispatchEvent(new CustomEvent('canvas-center-on', {
            detail: { mapX: menu.mapX, mapY: menu.mapY },
          }));
          close();
        }} />
      </div>
    </>
  );
}

function Item({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
      onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span style={{ fontSize: 13, width: 18, textAlign: 'center' }}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
