import { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitUpdateSettings, emitUpdateMapLighting } from '../../socket/emitters';
import type { AmbientLight } from '@dnd-vtt/shared';
import { CreatureLibrary } from './CreatureLibrary';
import { SceneManager } from './SceneManager';
import { EncounterBuilder } from './EncounterBuilder';
import { CompendiumPanel } from '../compendium/CompendiumPanel';
import { theme } from '../../styles/theme';
import { EMOJI } from '../../styles/emoji';
import { Section, Button, NumberInput, FieldGroup, Divider } from '../ui';
import { MusicPlayer } from './MusicPlayer';
import { HandoutSender } from './HandoutSender';
import { SessionPrivacyPanel } from './SessionPrivacyPanel';
import { RULE_SOURCES, type RuleSource } from '@dnd-vtt/shared';

type DMView = 'maps' | 'creatures' | 'encounters' | 'settings' | 'handouts' | 'music' | 'homebrew';

/** Panel definition for the 3x2 icon grid. */
interface PanelDef {
  id: DMView;
  emoji: string;
  label: string;
}

const PANELS: PanelDef[] = [
  { id: 'maps', emoji: '🗺️', label: 'Maps' },
  { id: 'creatures', emoji: '⚔️', label: 'Creatures' },
  { id: 'encounters', emoji: '🎲', label: 'Encounters' },
  { id: 'settings', emoji: '⚙️', label: 'Settings' },
  { id: 'handouts', emoji: '📜', label: 'Handouts' },
  { id: 'music', emoji: '🎵', label: 'Music' },
  { id: 'homebrew', emoji: '📚', label: 'Homebrew' },
];

/**
 * DM Tools tab content. Uses a 3x2 icon grid at the top with the
 * active panel's content rendered below. The grid stays sticky so
 * the DM can switch panels without scrolling back up.
 *
 * Creatures and Maps still take over the full sidebar (they have
 * their own back buttons) when the DM opens their full sub-views.
 */
export function DMToolbar() {
  const [activePanel, setActivePanel] = useState<DMView>('maps');
  const [subView, setSubView] = useState<'creature-library' | 'scene-manager' | null>(null);
  const currentMap = useMapStore((s) => s.currentMap);
  const settings = useSessionStore((s) => s.settings);

  const handleOpenMapLibrary = () => {
    if (!currentMap) {
      window.dispatchEvent(new CustomEvent('open-map-browser'));
      return;
    }
    setSubView('scene-manager');
  };

  // Full-screen sub-views (take over the sidebar)
  if (subView === 'creature-library') {
    return (
      <div style={styles.container}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={12} />}
          onClick={() => setSubView(null)}
          style={{ alignSelf: 'flex-start', marginBottom: theme.space.md }}
        >
          Back to DM Tools
        </Button>
        <CreatureLibrary />
      </div>
    );
  }

  if (subView === 'scene-manager') {
    return (
      <div style={styles.container}>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ArrowLeft size={12} />}
          onClick={() => setSubView(null)}
          style={{ alignSelf: 'flex-start', marginBottom: theme.space.md }}
        >
          Back to DM Tools
        </Button>
        <SceneManager />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <h3 style={styles.title}>
        <span style={{ marginRight: theme.space.sm }}>{EMOJI.map.dm}</span>
        DM Tools
      </h3>

      {/* ── 3x2 Icon Grid ── */}
      <div style={styles.iconGrid}>
        {PANELS.map((panel) => {
          const isActive = activePanel === panel.id;
          return (
            <button
              key={panel.id}
              onClick={() => setActivePanel(panel.id)}
              style={{
                ...styles.iconBtn,
                ...(isActive ? styles.iconBtnActive : {}),
              }}
              title={panel.label}
            >
              <span style={{ fontSize: 20, lineHeight: 1 }}>{panel.emoji}</span>
              <span style={styles.iconLabel}>{panel.label}</span>
            </button>
          );
        })}
      </div>

      <Divider variant="ornate" marginY={theme.space.xs} />

      {/* ── Active Panel Content ── */}
      <div style={styles.panelContent}>
        {activePanel === 'maps' && (
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
        )}

        {activePanel === 'creatures' && (
          <Section title="Creatures & NPCs" emoji={EMOJI.combat.attack}>
            <p style={styles.hint}>
              Browse and spawn monsters, NPCs, and enemies onto the map
            </p>
            <Button
              variant="primary"
              size="md"
              fullWidth
              onClick={() => setSubView('creature-library')}
              disabled={!currentMap}
            >
              Open Creature Library
            </Button>
          </Section>
        )}

        {activePanel === 'encounters' && <EncounterBuilder />}

        {activePanel === 'settings' && <SettingsPanel settings={settings} currentMap={currentMap} />}

        {activePanel === 'handouts' && <HandoutSender />}

        {activePanel === 'music' && <MusicPlayer />}

        {activePanel === 'homebrew' && (
          <div style={{ height: '100%', minHeight: 360 }}>
            {/* Reuse the compendium panel pinned to the homebrew scope.
                lockCategory hides the monsters/spells/items pills so it
                reads as a dedicated authoring view; the panel still
                surfaces the "+ Create" monster/spell/item buttons. */}
            <CompendiumPanel initialCategory="homebrew" lockCategory />
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  currentMap,
}: {
  settings: {
    gridSize: number;
    gridOpacity: number;
    enableFogOfWar: boolean;
    enableDynamicLighting: boolean;
    showTokenLabels?: boolean;
    turnTimerEnabled?: boolean;
    turnTimerSeconds?: number;
    discordWebhookUrl?: string | null;
    fogVisionCells?: number;
    ruleSources?: RuleSource[];
  };
  currentMap: { id: string; ambientLight?: AmbientLight; ambientOpacity?: number } | null;
}) {
  const visionCells = settings.fogVisionCells ?? 8;
  const activeSources = new Set<RuleSource>(settings.ruleSources ?? ['phb']);
  const toggleSource = (code: RuleSource) => {
    // PHB is always on — the core rules can't be opt-out.
    if (code === 'phb') return;
    const next = new Set(activeSources);
    if (next.has(code)) next.delete(code); else next.add(code);
    next.add('phb');
    emitUpdateSettings({ ruleSources: Array.from(next) });
  };
  return (
    <div style={styles.settingsContainer}>
      <h3 style={styles.settingsTitle}>Session Privacy</h3>
      <SessionPrivacyPanel />
      <Divider variant="ornate" marginY={theme.space.md} />

      <h3 style={styles.settingsTitle}>Game Settings</h3>
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

      {settings.enableFogOfWar && (
        <FieldGroup
          label="Vision Distance"
          helperText={`${visionCells} cells / ${visionCells * 5} ft around each hero`}
        >
          <input
            type="range"
            min={2}
            max={30}
            step={1}
            value={visionCells}
            onChange={(e) => emitUpdateSettings({ fogVisionCells: Number(e.target.value) })}
            style={styles.rangeInput}
          />
        </FieldGroup>
      )}

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

      {/* Per-map ambient light (5e Vision & Light). Bright = no fog,
          Dim = 45% overlay + disadvantage on Perception (DM narrates),
          Dark = 85% overlay + darkvision/blindsight/truesight become
          the primary vision sources. Custom lets the DM fine-tune the
          fog alpha while keeping the nearest preset's vision math. */}
      {currentMap && (
        <AmbientLightControl
          mapId={currentMap.id}
          tier={(currentMap.ambientLight as AmbientLight | undefined) ?? 'bright'}
          opacity={currentMap.ambientOpacity}
        />
      )}

      <div
        style={styles.settingRow}
        onClick={() =>
          emitUpdateSettings({
            showTokenLabels: !settings.showTokenLabels,
          })
        }
      >
        <span style={styles.settingLabel}>Show Token Labels</span>
        <ToggleSwitch checked={settings.showTokenLabels ?? false} />
      </div>
      <p style={styles.hint}>
        When enabled, token names are permanently visible below all tokens.
      </p>

      <Divider variant="ornate" marginY={theme.space.md} />

      <div
        style={styles.settingRow}
        onClick={() =>
          emitUpdateSettings({ turnTimerEnabled: !settings.turnTimerEnabled })
        }
      >
        <span style={styles.settingLabel}>Turn Timer</span>
        <ToggleSwitch checked={!!settings.turnTimerEnabled} />
      </div>
      <p style={styles.hint}>
        Show a countdown timer during each combatant's turn.
      </p>

      {settings.turnTimerEnabled && (
        <FieldGroup label="Timer Duration (seconds)">
          <NumberInput
            value={settings.turnTimerSeconds ?? 60}
            onChange={(e) =>
              emitUpdateSettings({ turnTimerSeconds: Number(e.target.value) })
            }
            min={15}
            max={300}
            step={5}
            size="md"
            fullWidth={false}
            containerStyle={{ width: 100 }}
          />
        </FieldGroup>
      )}

      <Divider variant="ornate" marginY={theme.space.md} />

      {/* Rule sources — which books the engine enforces. PHB is
          mandatory (core rules); the rest are opt-in. Today this gate
          mostly affects the wiki surface; rule handlers will honor it
          once each declares its source (see rules-engine plan memory).
          UI = a compact checklist so the DM can see the full set at a
          glance without a modal. */}
      <h3 style={styles.settingsTitle}>Rule Sources</h3>
      <p style={styles.hint}>
        Which rulebooks does this session use? PHB is always on. Toggling a
        source affects the wiki + (incrementally) the rules engine.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
        {RULE_SOURCES.map((src) => {
          const active = src.code === 'phb' || activeSources.has(src.code);
          const locked = src.code === 'phb';
          return (
            <div
              key={src.code}
              onClick={() => toggleSource(src.code)}
              title={locked ? 'PHB is always enabled.' : 'Click to toggle.'}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '8px 10px',
                borderRadius: theme.radius.sm,
                border: `1px solid ${active ? theme.gold.border : theme.border.default}`,
                background: active ? theme.gold.bg : theme.bg.deep,
                cursor: locked ? 'default' : 'pointer',
                opacity: locked ? 0.85 : 1,
              }}
            >
              <div style={{
                width: 16, height: 16, marginTop: 1, borderRadius: 3,
                background: active ? theme.gold.primary : 'transparent',
                border: `1px solid ${active ? theme.gold.primary : theme.border.default}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: theme.bg.base, fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>
                {active ? '✓' : ''}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: theme.text.primary }}>
                  {src.name} <span style={{ color: theme.text.muted, fontWeight: 400 }}>({src.code.toUpperCase()})</span>
                </div>
                <div style={{ fontSize: 10, color: theme.text.muted, marginTop: 2, lineHeight: 1.35 }}>
                  {src.description}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Divider variant="ornate" marginY={theme.space.md} />

      <DiscordWebhookField
        value={settings.discordWebhookUrl ?? ''}
        onSave={(url) => emitUpdateSettings({ discordWebhookUrl: url })}
      />
    </div>
  );
}

/**
 * Inline field for the session's Discord webhook URL. Debounce-free:
 * user clicks Save to commit (which validates on the server via zod).
 * We deliberately DO NOT auto-save-on-blur because a malformed URL
 * would silently clear the field; a visible Save button makes the
 * transition obvious.
 */
function DiscordWebhookField({
  value, onSave,
}: { value: string; onSave: (url: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  const dirty = draft !== value;

  const handleSave = () => {
    const trimmed = draft.trim();
    onSave(trimmed === '' ? null : trimmed);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const placeholder = 'https://discord.com/api/webhooks/…';
  return (
    <FieldGroup
      label="Discord Webhook (optional)"
      helperText="Posts combat start/end + dramatic death-save notifications to Discord. Clear the field and Save to disable."
    >
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="url"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) handleSave(); }}
          style={{
            flex: 1, minWidth: 0,
            padding: '6px 8px', fontSize: 11,
            background: theme.bg.deep, color: theme.text.primary,
            border: `1px solid ${theme.border.default}`, borderRadius: 4,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty}
          style={{
            padding: '6px 10px', fontSize: 11, fontWeight: 700,
            background: dirty ? theme.gold.primary : theme.bg.deep,
            color: dirty ? '#1a1a1a' : theme.text.muted,
            border: `1px solid ${dirty ? theme.gold.primary : theme.border.default}`,
            borderRadius: 4, cursor: dirty ? 'pointer' : 'default',
          }}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </FieldGroup>
  );
}

/**
 * DM control for per-map ambient light. Three preset buttons (Bright
 * / Dim / Dark) plus a "Custom" slider that only renders when the
 * `custom` tier is active. Changes emit `map:update-lighting`, which
 * the server persists + broadcasts to every client on this map.
 *
 * Mechanical mapping (from shared/src/types/map.ts):
 *   bright → 0.00 alpha, darkvision adds nothing
 *   dim    → 0.45 alpha, darkvision adds nothing
 *   dark   → 0.85 alpha, darkvision / blindsight / truesight become
 *            the primary vision sources
 *   custom → whatever the slider is at; vision math uses the nearest
 *            preset (≥0.7 dark, ≥0.25 dim, else bright)
 */
function AmbientLightControl({
  mapId,
  tier,
  opacity,
}: {
  mapId: string;
  tier: AmbientLight;
  opacity: number | undefined;
}) {
  const tiers: Array<{ id: AmbientLight; label: string; emoji: string }> = [
    { id: 'bright', label: 'Bright', emoji: '☀️' },
    { id: 'dim', label: 'Dim', emoji: '🌆' },
    { id: 'dark', label: 'Dark', emoji: '🌑' },
    { id: 'custom', label: 'Custom', emoji: '🎚️' },
  ];
  const sliderVal = typeof opacity === 'number'
    ? Math.round(opacity * 100)
    : tier === 'dark' ? 85 : tier === 'dim' ? 45 : 0;

  return (
    <FieldGroup
      label="Ambient Light"
      helperText="5e Vision & Light — affects fog alpha + darkvision tiering for every token on this map."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {tiers.map(({ id, label, emoji }) => {
          const active = tier === id;
          return (
            <button
              key={id}
              onClick={() => emitUpdateMapLighting(mapId, {
                ambientLight: id,
                // Clear opacity when switching away from 'custom' so
                // the preset alpha takes over cleanly. Keep existing
                // opacity when going INTO 'custom'.
                ambientOpacity: id === 'custom' ? undefined : null,
              })}
              title={`Set ambient to ${label}`}
              style={{
                flex: 1,
                padding: '6px 4px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase' as const,
                borderRadius: theme.radius.sm,
                cursor: 'pointer',
                background: active
                  ? `linear-gradient(180deg, rgba(232,196,85,0.18), ${theme.gold.bg})`
                  : theme.bg.deep,
                color: active ? theme.gold.bright : theme.text.secondary,
                border: `1px solid ${active ? theme.gold.border : theme.border.default}`,
                fontFamily: theme.font.body,
              }}
            >
              <span style={{ marginRight: 4 }}>{emoji}</span>{label}
            </button>
          );
        })}
      </div>
      {tier === 'custom' && (
        <div style={{ marginTop: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: theme.text.muted, marginBottom: 4 }}>
            <span>Opacity</span>
            <span>{sliderVal}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={sliderVal}
            onChange={(e) => emitUpdateMapLighting(mapId, {
              ambientOpacity: Number(e.target.value) / 100,
            })}
            style={styles.rangeInput}
          />
        </div>
      )}
    </FieldGroup>
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
    flex: 1,
    minHeight: 0,
  },
  title: {
    ...theme.type.display,
    color: theme.gold.primary,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
  },
  iconGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
    position: 'sticky' as const,
    top: 0,
    zIndex: 2,
    background: theme.bg.base,
    paddingTop: theme.space.sm,
    paddingBottom: theme.space.sm,
  },
  iconBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    width: '100%',
    height: 58,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    transition: `all ${theme.motion.fast}`,
  },
  iconBtnActive: {
    borderColor: theme.gold.primary,
    background: theme.gold.bg,
    color: theme.gold.primary,
    boxShadow: theme.goldGlow.soft,
  },
  iconLabel: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  },
  panelContent: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: theme.space.md,
    flex: 1,
    minHeight: 0,
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
  settingsTitle: {
    ...theme.type.display,
    color: theme.gold.primary,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
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
