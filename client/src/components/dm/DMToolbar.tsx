import { useState, useCallback } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import {
  emitStartCombat,
  emitEndCombat,
  emitUpdateSettings,
} from '../../socket/emitters';
import { CreatureLibrary } from './CreatureLibrary';
import { theme } from '../../styles/theme';

type DMView = 'main' | 'creatures' | 'settings';

export function DMToolbar() {
  const [view, setView] = useState<DMView>('main');
  const combatActive = useCombatStore((s) => s.active);
  const tokens = useMapStore((s) => s.tokens);
  const currentMap = useMapStore((s) => s.currentMap);
  const settings = useSessionStore((s) => s.settings);

  if (view === 'creatures') {
    return (
      <div style={styles.container}>
        <button style={styles.backButton} onClick={() => setView('main')}>
          Back to DM Tools
        </button>
        <CreatureLibrary />
      </div>
    );
  }

  if (view === 'settings') {
    return (
      <div style={styles.container}>
        <button style={styles.backButton} onClick={() => setView('main')}>
          Back to DM Tools
        </button>
        <SettingsPanel settings={settings} />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>DM Tools</h3>

      {/* Map Section */}
      <Section title="Map">
        {currentMap ? (
          <div style={styles.mapInfo}>
            <span style={styles.mapName}>{currentMap.name}</span>
            <span style={styles.mapSize}>{currentMap.width / currentMap.gridSize}x{currentMap.height / currentMap.gridSize}</span>
          </div>
        ) : (
          <p style={styles.hint}>No map loaded</p>
        )}
        <div style={styles.buttonRow}>
          <button style={styles.actionButton} onClick={() => window.dispatchEvent(new CustomEvent('open-map-browser'))}>
            Load Map
          </button>
          <button style={styles.actionButton} onClick={() => window.dispatchEvent(new CustomEvent('open-map-upload'))}>
            Upload Map
          </button>
        </div>
      </Section>

      {/* Creatures & NPCs */}
      <Section title="Creatures & NPCs">
        <p style={styles.hint}>Browse and spawn monsters, NPCs, and enemies onto the map</p>
        <button
          style={styles.primaryButton}
          onClick={() => setView('creatures')}
          disabled={!currentMap}
        >
          Open Creature Library
        </button>
      </Section>

      {/* Combat */}
      <Section title="Combat">
        {!combatActive ? (
          <>
            <button
              style={styles.dangerButton}
              onClick={() => {
                const tokenIds = Object.keys(tokens);
                if (tokenIds.length > 0) emitStartCombat(tokenIds);
              }}
              disabled={Object.keys(tokens).length === 0}
            >
              Start Combat
            </button>
            <p style={styles.hint}>
              {Object.keys(tokens).length === 0
                ? 'Place tokens on the map first'
                : `${Object.keys(tokens).length} token(s) will enter initiative`}
            </p>
          </>
        ) : (
          <>
            <div style={styles.combatBadge}>
              <span style={styles.combatDot} />
              Combat Active
            </div>
            <button style={styles.dangerButton} onClick={emitEndCombat}>
              End Combat
            </button>
          </>
        )}
      </Section>

      {/* Settings */}
      <Section title="Settings">
        <button style={styles.actionButton} onClick={() => setView('settings')}>
          Game Settings
        </button>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function SettingsPanel({ settings }: { settings: { gridSize: number; gridOpacity: number; enableFogOfWar: boolean; enableDynamicLighting: boolean } }) {
  return (
    <div style={styles.settingsContainer}>
      <h3 style={styles.title}>Game Settings</h3>

      <div style={styles.settingRow}>
        <span style={styles.settingLabel}>Grid Size (px)</span>
        <input
          type="number"
          value={settings.gridSize}
          onChange={(e) => emitUpdateSettings({ gridSize: Number(e.target.value) })}
          style={styles.numberInput}
          min={20} max={200} step={5}
        />
      </div>

      <div style={styles.settingRow}>
        <span style={styles.settingLabel}>Grid Opacity</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.gridOpacity ?? 0.15}
            onChange={(e) => emitUpdateSettings({ gridOpacity: Number(e.target.value) })}
            style={styles.rangeInput}
          />
          <span style={{ fontSize: 11, color: theme.text.muted, width: 32, textAlign: 'right' as const }}>
            {Math.round((settings.gridOpacity ?? 0.15) * 100)}%
          </span>
        </div>
      </div>

      <div style={styles.settingRow} onClick={() => emitUpdateSettings({ enableFogOfWar: !settings.enableFogOfWar })}>
        <span style={styles.settingLabel}>Fog of War (players only)</span>
        <ToggleSwitch checked={settings.enableFogOfWar} />
      </div>
      <p style={styles.hint}>Players see fog around areas without their hero. GM always sees full map.</p>

      <div style={styles.settingRow} onClick={() => emitUpdateSettings({ enableDynamicLighting: !settings.enableDynamicLighting })}>
        <span style={styles.settingLabel}>Dynamic Lighting</span>
        <ToggleSwitch checked={settings.enableDynamicLighting} />
      </div>
      <p style={styles.hint}>Uses walls to block line of sight and cast shadows from light sources.</p>
    </div>
  );
}

function ToggleSwitch({ checked }: { checked: boolean }) {
  return (
    <div style={{
      width: 36, height: 20, borderRadius: 10, position: 'relative' as const, cursor: 'pointer',
      background: checked ? 'rgba(212, 168, 67, 0.3)' : theme.bg.deep,
      border: `1px solid ${checked ? theme.gold.border : theme.border.default}`,
      transition: 'all 0.2s',
    }}>
      <div style={{
        width: 14, height: 14, borderRadius: 7, position: 'absolute' as const, top: 2,
        left: checked ? 18 : 2, transition: 'all 0.2s',
        background: checked ? theme.gold.primary : theme.text.muted,
      }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    padding: 16,
    gap: 4,
    overflowY: 'auto',
    height: '100%',
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.gold.primary,
    fontFamily: theme.font.display,
    margin: '0 0 8px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '12px 0',
    borderBottom: `1px solid ${theme.border.default}`,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    color: theme.gold.dim,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  hint: {
    fontSize: 11,
    color: theme.text.muted,
    margin: 0,
    lineHeight: 1.4,
  },
  buttonRow: {
    display: 'flex',
    gap: 6,
  },
  actionButton: {
    flex: 1,
    padding: '8px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    transition: 'all 0.15s',
  },
  primaryButton: {
    padding: '10px 16px',
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    background: 'rgba(212, 168, 67, 0.15)',
    color: theme.gold.primary,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    transition: 'all 0.15s',
  },
  dangerButton: {
    padding: '10px 16px',
    border: `1px solid rgba(192, 57, 43, 0.5)`,
    borderRadius: theme.radius.sm,
    background: 'rgba(192, 57, 43, 0.15)',
    color: theme.danger,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    transition: 'all 0.15s',
  },
  backButton: {
    padding: '6px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    fontSize: 11,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  mapInfo: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 10px',
    background: theme.bg.elevated,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
  },
  mapName: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.primary,
  },
  mapSize: {
    fontSize: 11,
    color: theme.text.muted,
  },
  combatBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    background: 'rgba(192, 57, 43, 0.1)',
    border: `1px solid rgba(192, 57, 43, 0.3)`,
    borderRadius: theme.radius.sm,
    color: theme.danger,
    fontSize: 13,
    fontWeight: 600,
  },
  combatDot: {
    width: 8, height: 8, borderRadius: 4,
    background: theme.danger,
    animation: 'pulse 2s ease-in-out infinite',
  },
  settingsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  settingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    padding: '4px 0',
  },
  settingLabel: {
    fontSize: 13,
    color: theme.text.secondary,
  },
  numberInput: {
    width: 60,
    padding: '4px 8px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    color: theme.text.primary,
    fontSize: 12,
    textAlign: 'center' as const,
  },
  rangeInput: {
    width: 80,
    height: 4,
    cursor: 'pointer',
    accentColor: theme.gold.primary,
  },
};
