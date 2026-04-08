import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitUpdateSettings } from '../../socket/emitters';
import { CreatureLibrary } from './CreatureLibrary';
import { SceneManager } from './SceneManager';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { Section, Button, NumberInput, FieldGroup, Divider } from '../ui';

type DMView = 'main' | 'creatures' | 'maps' | 'settings';

/**
 * DM Tools tab content. Rewritten for the UI unification pass using
 * shared primitives (Section, Button, Divider, NumberInput).
 *
 * Renders one of four views:
 *   • main       — section cards with buttons to open each sub-view
 *   • creatures  — full creature library
 *   • maps       — full scene / map manager (layers, previews, activate)
 *   • settings   — game settings form
 *
 * Both the creature library and the map library live behind buttons
 * so the DM has room to manage each one. If no map is loaded when
 * "Open Map Library" is clicked, we short-circuit to the global
 * MapBrowser overlay (map picker) via the `open-map-browser` event
 * instead of switching to the scene manager view.
 */
export function DMToolbar() {
  const [view, setView] = useState<DMView>('main');
  const currentMap = useMapStore((s) => s.currentMap);
  const settings = useSessionStore((s) => s.settings);

  const handleOpenMapLibrary = () => {
    if (!currentMap) {
      // No map loaded yet — go straight to the map picker overlay so
      // the DM can pick an initial map before managing scene layers.
      window.dispatchEvent(new CustomEvent('open-map-browser'));
      return;
    }
    setView('maps');
  };

  if (view === 'creatures') {
    return (
      <div style={styles.container}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={12} />}
          onClick={() => setView('main')}
          style={{ alignSelf: 'flex-start', marginBottom: theme.space.md }}
        >
          Back to DM Tools
        </Button>
        <CreatureLibrary />
      </div>
    );
  }

  if (view === 'maps') {
    return (
      <div style={styles.container}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={12} />}
          onClick={() => setView('main')}
          style={{ alignSelf: 'flex-start', marginBottom: theme.space.md }}
        >
          Back to DM Tools
        </Button>
        <SceneManager />
      </div>
    );
  }

  if (view === 'settings') {
    return (
      <div style={styles.container}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={12} />}
          onClick={() => setView('main')}
          style={{ alignSelf: 'flex-start', marginBottom: theme.space.md }}
        >
          Back to DM Tools
        </Button>
        <SettingsPanel settings={settings} />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h3 style={styles.title}>
        <span style={{ marginRight: theme.space.sm }}>{EMOJI.map.dm}</span>
        DM Tools
      </h3>

      <Divider variant="ornate" marginY={theme.space.sm} />

      {/* Scenes & Maps */}
      <Section title="Scenes & Maps" emoji={EMOJI.map.dm}>
        <p style={styles.hint}>
          {currentMap
            ? 'Manage map layers, preview scenes, or add a new map to the campaign.'
            : 'No map loaded yet. Open the map library to pick your first scene.'}
        </p>
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={handleOpenMapLibrary}
        >
          Open Map Library
        </Button>
      </Section>

      <Divider variant="plain" />

      {/* Creatures & NPCs */}
      <Section title="Creatures & NPCs" emoji={EMOJI.combat.attack}>
        <p style={styles.hint}>
          Browse and spawn monsters, NPCs, and enemies onto the map
        </p>
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={() => setView('creatures')}
          disabled={!currentMap}
        >
          Open Creature Library
        </Button>
      </Section>

      <Divider variant="plain" />

      {/* Settings */}
      <Section title="Settings" emoji="⚙">
        <Button variant="ghost" size="md" fullWidth onClick={() => setView('settings')}>
          Game Settings
        </Button>
      </Section>
    </div>
  );
}

function SettingsPanel({
  settings,
}: {
  settings: {
    gridSize: number;
    gridOpacity: number;
    enableFogOfWar: boolean;
    enableDynamicLighting: boolean;
  };
}) {
  return (
    <div style={styles.settingsContainer}>
      <h3 style={styles.title}>Game Settings</h3>
      <Divider variant="ornate" marginY={theme.space.sm} />

      <FieldGroup label="Grid Size (px)">
        <NumberInput
          value={settings.gridSize}
          onChange={(e) =>
            emitUpdateSettings({ gridSize: Number(e.target.value) })
          }
          min={20}
          max={200}
          step={5}
          size="md"
          fullWidth={false}
          containerStyle={{ width: 100 }}
        />
      </FieldGroup>

      <FieldGroup
        label="Grid Opacity"
        helperText={`${Math.round((settings.gridOpacity ?? 0.15) * 100)}%`}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.gridOpacity ?? 0.15}
          onChange={(e) =>
            emitUpdateSettings({ gridOpacity: Number(e.target.value) })
          }
          style={styles.rangeInput}
        />
      </FieldGroup>

      <div
        style={styles.settingRow}
        onClick={() =>
          emitUpdateSettings({ enableFogOfWar: !settings.enableFogOfWar })
        }
      >
        <span style={styles.settingLabel}>Fog of War (players only)</span>
        <ToggleSwitch checked={settings.enableFogOfWar} />
      </div>
      <p style={styles.hint}>
        Players see fog around areas without their hero. GM always sees full map.
      </p>

      <div
        style={styles.settingRow}
        onClick={() =>
          emitUpdateSettings({
            enableDynamicLighting: !settings.enableDynamicLighting,
          })
        }
      >
        <span style={styles.settingLabel}>Dynamic Lighting</span>
        <ToggleSwitch checked={settings.enableDynamicLighting} />
      </div>
      <p style={styles.hint}>
        Uses walls to block line of sight and cast shadows from light sources.
      </p>
    </div>
  );
}

function ToggleSwitch({ checked }: { checked: boolean }) {
  return (
    <div
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        position: 'relative' as const,
        cursor: 'pointer',
        background: checked ? theme.gold.bg : theme.bg.deep,
        border: `1px solid ${checked ? theme.gold.border : theme.border.default}`,
        transition: `all ${theme.motion.normal}`,
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          position: 'absolute' as const,
          top: 2,
          left: checked ? 18 : 2,
          transition: `all ${theme.motion.normal}`,
          background: checked ? theme.gold.primary : theme.text.muted,
          boxShadow: checked ? theme.goldGlow.soft : 'none',
        }}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    padding: theme.space.xl,
    gap: theme.space.xs,
    overflowY: 'auto',
    height: '100%',
  },
  title: {
    ...theme.type.display,
    color: theme.gold.primary,
    margin: `0 0 ${theme.space.md}px`,
    display: 'flex',
    alignItems: 'center',
  },
  hint: {
    ...theme.type.small,
    color: theme.text.muted,
    margin: 0,
    lineHeight: 1.5,
  },
  settingsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.space.lg,
  },
  settingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    padding: `${theme.space.xs}px 0`,
  },
  settingLabel: {
    ...theme.type.body,
    color: theme.text.secondary,
  },
  rangeInput: {
    width: '100%',
    height: 4,
    cursor: 'pointer',
    accentColor: theme.gold.primary,
  },
};
