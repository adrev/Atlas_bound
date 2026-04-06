import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useCharacterStore, type HotbarSlot } from '../../stores/useCharacterStore';
import { emitRoll } from '../../socket/emitters';
import type { Spell } from '@dnd-vtt/shared';
import { theme } from '../../styles/theme';

function SlotDisplay({ slot, index }: { slot: HotbarSlot; index: number }) {
  const setHotbarSlot = useCharacterStore((s) => s.setHotbarSlot);
  const [hovered, setHovered] = useState(false);

  const handleActivate = () => {
    if (!slot.data) return;

    if (slot.type === 'spell' && typeof slot.data === 'object' && slot.data !== null) {
      const spell = slot.data as Spell;
      if (spell.damage) {
        emitRoll(spell.damage, spell.name);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.type && data.data) {
        setHotbarSlot(index, { type: data.type, data: data.data });
      }
    } catch {
      // ignore invalid drops
    }
  };

  const isEmpty = !slot.data;
  const spellData = slot.type === 'spell' && typeof slot.data === 'object' ? slot.data as Spell : null;
  const label = spellData?.name || (typeof slot.data === 'string' ? slot.data : null);

  return (
    <div
      style={{
        ...styles.slot,
        ...(isEmpty ? styles.slotEmpty : {}),
        ...(hovered && !isEmpty ? styles.slotHover : {}),
      }}
      onClick={handleActivate}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={spellData ? `${spellData.name}\n${spellData.description}` : label || `Slot ${index + 1}`}
    >
      {isEmpty ? (
        <Plus size={14} color={theme.text.muted} />
      ) : (
        <span style={styles.slotLabel}>
          {label ? label.substring(0, 4) : '?'}
        </span>
      )}
      <span style={styles.slotKey}>{index === 9 ? '0' : `${index + 1}`}</span>

      {/* Tooltip on hover */}
      {hovered && spellData && (
        <div style={styles.tooltip}>
          <div style={styles.tooltipName}>{spellData.name}</div>
          <div style={styles.tooltipMeta}>
            Lv.{spellData.level} {spellData.school}
          </div>
          {spellData.damage && (
            <div style={styles.tooltipDamage}>
              {spellData.damage} {spellData.damageType || ''}
            </div>
          )}
          <div style={styles.tooltipDesc}>
            {spellData.description.substring(0, 100)}
            {spellData.description.length > 100 ? '...' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

export function Hotbar() {
  const hotbarSlots = useCharacterStore((s) => s.hotbarSlots);

  // Keyboard shortcuts - use ref to avoid infinite loop from array dependency
  const slotsRef = useRef(hotbarSlots);
  slotsRef.current = hotbarSlots;

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
        return;
      }
      const keyNum = parseInt(e.key);
      if (isNaN(keyNum)) return;
      const index = keyNum === 0 ? 9 : keyNum - 1;
      const slot = slotsRef.current[index];
      if (!slot?.data) return;
      if (slot.type === 'spell' && typeof slot.data === 'object' && slot.data !== null) {
        const spell = slot.data as Spell;
        if (spell.damage) {
          emitRoll(spell.damage, spell.name);
        }
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  return (
    <div style={styles.container}>
      {hotbarSlots.map((slot, i) => (
        <SlotDisplay key={i} slot={slot} index={i} />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '0 8px',
  },
  slot: {
    width: 52,
    height: 52,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(30, 30, 50, 0.8)',
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    position: 'relative' as const,
    userSelect: 'none',
  },
  slotEmpty: {
    borderStyle: 'dashed',
    opacity: 0.5,
  },
  slotHover: {
    borderColor: theme.gold.primary,
    background: theme.gold.bg,
    boxShadow: `0 0 8px ${theme.gold.border}`,
  },
  slotLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: theme.text.primary,
    textAlign: 'center' as const,
    lineHeight: 1.1,
    overflow: 'hidden',
  },
  slotKey: {
    position: 'absolute' as const,
    bottom: 2,
    right: 4,
    fontSize: 9,
    fontWeight: 700,
    color: theme.text.muted,
    fontFamily: 'monospace',
  },
  tooltip: {
    position: 'absolute' as const,
    bottom: '100%',
    left: '50%',
    transform: 'translateX(-50%)',
    marginBottom: 8,
    padding: '10px 14px',
    background: theme.bg.deep,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.lg,
    minWidth: 180,
    maxWidth: 260,
    zIndex: 100,
    pointerEvents: 'none' as const,
    animation: 'fadeIn 0.15s ease',
  },
  tooltipName: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.gold.primary,
    marginBottom: 4,
  },
  tooltipMeta: {
    fontSize: 11,
    color: theme.text.muted,
    marginBottom: 4,
  },
  tooltipDamage: {
    fontSize: 12,
    color: theme.danger,
    fontWeight: 600,
    marginBottom: 4,
  },
  tooltipDesc: {
    fontSize: 11,
    color: theme.text.secondary,
    lineHeight: 1.3,
  },
};
