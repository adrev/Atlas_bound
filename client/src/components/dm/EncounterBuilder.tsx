import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, Play, Plus, Minus, Save, X } from 'lucide-react';
import { useSessionStore } from '../../stores/useSessionStore';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { emitTokenAdd } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import { Button, Section, Divider } from '../ui';
import type { CompendiumMonster } from '@dnd-vtt/shared';
import { getCreatureIconUrl, getCreatureImageUrl } from '../../utils/compendiumIcons';
import { computeSpawnAnchor, computeTokenPosition } from '../../utils/zoneSpawn';

// --- Helpers (reused from CreatureLibrary) ---

/**
 * Token portrait URL. Prefers the real GCS PNG by slug; falls back
 * to a procedural SVG letter-avatar keyed on type colour. Previously
 * this helper was misnamed `getCreatureImagePng` but returned only
 * the letter-avatar, so every spawned encounter token had a
 * letter-circle portrait.
 */
function getCreatureTokenImage(slugOrName: string, type?: string): string {
  // If the caller has the slug, use it directly. Otherwise slugify
  // inside getCreatureImageUrl still produces the best-effort match.
  return getCreatureImageUrl(slugOrName) || getCreatureIconUrl(slugOrName, type);
}

const SIZE_MAP: Record<string, number> = {
  Tiny: 0.5, tiny: 0.5,
  Small: 1, small: 1,
  Medium: 1, medium: 1,
  Large: 2, large: 2,
  Huge: 3, huge: 3,
  Gargantuan: 4, gargantuan: 4,
};

const TYPE_COLORS: Record<string, string> = {
  Aberration: '#7b2d8e', Beast: '#6b8e23', Celestial: '#f0d866',
  Construct: '#8e8e8e', Dragon: '#c53131', Elemental: '#3a86c8',
  Fey: '#a0d468', Fiend: '#b22222', Giant: '#8b6f47',
  Humanoid: '#6a8ca0', Monstrosity: '#8b4513', Ooze: '#4caf50',
  Plant: '#2e7d32', Undead: '#5c5c7a',
};

function getTokenColor(type: string): string {
  return TYPE_COLORS[type] || '#666666';
}

function formatCR(cr: string | number): string {
  const n = typeof cr === 'string' ? parseFloat(cr) : cr;
  if (n === 0.125) return '1/8';
  if (n === 0.25) return '1/4';
  if (n === 0.5) return '1/2';
  if (n === 0) return '0';
  return String(n);
}

// --- Types ---

interface EncounterCreature {
  slug: string;
  name: string;
  count: number;
}

interface EncounterPreset {
  id: string;
  sessionId: string;
  name: string;
  creatures: EncounterCreature[];
  createdAt: string;
}

// --- Component ---

export function EncounterBuilder() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const currentMap = useMapStore((s) => s.currentMap);
  const zones = useMapStore((s) => s.zones);
  const [mode, setMode] = useState<'list' | 'build'>('list');
  const [presets, setPresets] = useState<EncounterPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [deploying, setDeploying] = useState<string | null>(null);
  /**
   * Where to drop creatures when the DM clicks Deploy. `null` = use the
   * map's geometric center (legacy behavior); a zone id = scatter inside
   * that zone. Reset to null when the active map changes.
   */
  const [spawnZoneId, setSpawnZoneId] = useState<string | null>(null);

  // Build mode state
  const [encounterName, setEncounterName] = useState('');
  const [creatures, setCreatures] = useState<EncounterCreature[]>([]);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<CompendiumMonster[]>([]);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Fetch presets
  const fetchPresets = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/encounters`);
      if (resp.ok) {
        const data = await resp.json();
        setPresets(data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { fetchPresets(); }, [fetchPresets]);

  // Search creatures
  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const doSearch = async () => {
      setSearching(true);
      try {
        const sid = sessionId || 'default';
        const [srdData, customAll] = await Promise.all([
          fetch(`/api/compendium/search?q=${encodeURIComponent(search.trim())}&category=monsters&limit=10`, { signal: controller.signal })
            .then(r => r.ok ? r.json() : { results: [] }),
          fetch(`/api/custom/monsters?sessionId=${sid}`, { signal: controller.signal })
            .then(r => r.ok ? r.json() : []),
        ]);

        const srdSlugs: string[] = (srdData.results || []).map((r: { slug: string }) => r.slug);
        const q = search.trim().toLowerCase();
        const customMatches = (customAll as CompendiumMonster[]).filter(
          (m: CompendiumMonster) => m.name.toLowerCase().includes(q)
        );

        const fullMonsters: CompendiumMonster[] = [...customMatches];
        for (let i = 0; i < srdSlugs.length; i += 5) {
          const batch = await Promise.all(
            srdSlugs.slice(i, i + 5).map(async (slug) => {
              try {
                const r = await fetch(`/api/compendium/monsters/${slug}`, { signal: controller.signal });
                return r.ok ? r.json() as Promise<CompendiumMonster> : null;
              } catch { return null; }
            })
          );
          fullMonsters.push(...batch.filter(Boolean) as CompendiumMonster[]);
        }

        setSearchResults(fullMonsters);
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') {
          setSearchResults([]);
        }
      }
      setSearching(false);
    };

    const timeout = setTimeout(doSearch, 300);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [search, sessionId]);

  // Add creature to encounter
  const addCreature = (monster: CompendiumMonster) => {
    setCreatures((prev) => {
      const existing = prev.find((c) => c.slug === monster.slug);
      if (existing) {
        return prev.map((c) =>
          c.slug === monster.slug ? { ...c, count: Math.min(c.count + 1, 20) } : c
        );
      }
      return [...prev, { slug: monster.slug, name: monster.name, count: 1 }];
    });
    setSearch('');
    setSearchResults([]);
  };

  // Update creature count
  const updateCount = (slug: string, delta: number) => {
    setCreatures((prev) =>
      prev
        .map((c) => c.slug === slug ? { ...c, count: Math.max(0, Math.min(c.count + delta, 20)) } : c)
        .filter((c) => c.count > 0)
    );
  };

  // Remove creature
  const removeCreature = (slug: string) => {
    setCreatures((prev) => prev.filter((c) => c.slug !== slug));
  };

  // Save encounter
  const handleSave = async () => {
    if (!sessionId || !encounterName.trim() || creatures.length === 0) return;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/encounters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: encounterName.trim(), creatures }),
      });
      if (resp.ok) {
        setEncounterName('');
        setCreatures([]);
        setMode('list');
        fetchPresets();
      }
    } catch { /* ignore */ }
  };

  // Delete encounter
  const handleDelete = async (id: string) => {
    try {
      const resp = await fetch(`/api/encounters/${id}`, { method: 'DELETE' });
      if (resp.ok) {
        setPresets((prev) => prev.filter((p) => p.id !== id));
      }
    } catch { /* ignore */ }
  };

  // Deploy encounter
  const handleDeploy = async (presetId: string) => {
    if (!currentMap) return;
    setDeploying(presetId);
    try {
      const resp = await fetch(`/api/encounters/${presetId}/deploy`, { method: 'POST' });
      if (!resp.ok) return;
      const data = await resp.json();
      const allCreatures = data.creatures as EncounterCreature[];

      // Compute grid positions. Default: map center. If a spawn zone
      // is selected, use the zone's center instead (and clamp the
      // spawn area to the zone's bounds so creatures stay inside).
      // Math lives in `utils/zoneSpawn` so it's unit-tested.
      const gridSize = currentMap.gridSize || 70;
      const zone = spawnZoneId ? zones.find((z) => z.id === spawnZoneId) ?? null : null;

      let tokenIndex = 0;
      for (const creature of allCreatures) {
        // Fetch compendium data for this creature
        let monster: CompendiumMonster | null = null;
        try {
          const r = await fetch(`/api/compendium/monsters/${creature.slug}`);
          if (r.ok) monster = await r.json();
        } catch { /* ignore */ }

        // Also check custom monsters
        if (!monster && sessionId) {
          try {
            const r = await fetch(`/api/custom/monsters?sessionId=${sessionId}`);
            if (r.ok) {
              const customs = await r.json() as CompendiumMonster[];
              monster = customs.find((m) => m.slug === creature.slug) || null;
            }
          } catch { /* ignore */ }
        }

        const thisTokenSize = monster ? (SIZE_MAP[monster.size] ?? 1) : 1;
        // Re-anchor per creature so Large/Huge tokens get a bigger
        // margin inside the zone than Medium tokens. For maps without
        // a zone this is a no-op (anchor keeps infinite offsets).
        const creatureAnchor = computeSpawnAnchor(currentMap, zone, thisTokenSize);

        for (let i = 0; i < creature.count; i++) {
          const { x, y } = computeTokenPosition(
            tokenIndex, totalCreatureCount(allCreatures), creatureAnchor, gridSize,
          );

          const walkSpeed = monster?.speed?.walk ?? 30;
          const tokenSize = thisTokenSize;
          const tokenColor = monster ? getTokenColor(monster.type) : '#666666';

          // Create character record
          let characterId: string | null = null;
          if (monster) {
            try {
              const charResp = await fetch('/api/characters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  isNpc: true,
                  // Required by the server since the P1 security hardening —
                  // without it the POST 400s, characterId is null, and the
                  // spawned token has no backing HP row (silent half-fail).
                  sessionId,
                  name: creature.count > 1 ? `${monster.name} ${i + 1}` : monster.name,
                  race: monster.type,
                  class: `CR ${formatCR(monster.challengeRating)}`,
                  level: Math.max(1, Math.ceil(monster.crNumeric)),
                  hitPoints: monster.hitPoints,
                  maxHitPoints: monster.hitPoints,
                  armorClass: monster.armorClass,
                  speed: walkSpeed,
                  abilityScores: monster.abilityScores,
                  proficiencyBonus: Math.max(2, Math.floor((monster.crNumeric - 1) / 4) + 2),
                  portraitUrl: getCreatureTokenImage(monster.slug, monster.type),
                  compendiumSlug: monster.slug,
                }),
              });
              const charData = await charResp.json();
              characterId = charData?.id || null;

              if (characterId && charData) {
                useCharacterStore.getState().setAllCharacters({
                  ...useCharacterStore.getState().allCharacters,
                  [characterId]: charData,
                });
              }
            } catch { /* fallback without character */ }
          }

          emitTokenAdd({
            mapId: currentMap.id,
            characterId,
            name: creature.count > 1 ? `${creature.name} ${i + 1}` : creature.name,
            x,
            y,
            size: tokenSize,
            imageUrl: getCreatureTokenImage(monster?.slug ?? creature.name, monster?.type),
            color: tokenColor,
            layer: 'token',
            visible: true,
            hasLight: false,
            lightRadius: 140,
            lightDimRadius: 280,
            lightColor: '#ffcc66',
            conditions: [],
            ownerUserId: null,
          });

          tokenIndex++;
        }
      }
    } catch { /* ignore */ }
    setDeploying(null);
  };

  // --- Build Mode ---
  if (mode === 'build') {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <h4 style={styles.sectionTitle}>New Encounter</h4>
          <button
            style={styles.closeButton}
            onClick={() => { setMode('list'); setCreatures([]); setEncounterName(''); }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Encounter name */}
        <input
          type="text"
          value={encounterName}
          onChange={(e) => setEncounterName(e.target.value)}
          placeholder="Encounter name (e.g. Forest Ambush)"
          style={styles.nameInput}
        />

        {/* Creature search */}
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search creatures to add..."
            style={styles.searchInput}
          />
          {searchResults.length > 0 && (
            <div style={styles.searchDropdown}>
              {searchResults.map((m) => (
                <button
                  key={m.slug}
                  style={styles.searchResult}
                  onClick={() => addCreature(m)}
                >
                  <img src={getCreatureIconUrl(m.name, m.type)} alt="" style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
                  <span style={styles.searchResultName}>{m.name}</span>
                  <span style={styles.searchResultMeta}>
                    CR {formatCR(m.challengeRating)} | {m.type}
                  </span>
                </button>
              ))}
            </div>
          )}
          {searching && (
            <div style={styles.searchDropdown}>
              <div style={{ padding: 8, color: theme.text.muted, fontSize: 11 }}>
                Searching...
              </div>
            </div>
          )}
        </div>

        {/* Creature list */}
        <div style={styles.creatureList}>
          {creatures.length === 0 && (
            <div style={{ color: theme.text.muted, fontSize: 11, textAlign: 'center', padding: 16 }}>
              Search and add creatures above
            </div>
          )}
          {creatures.map((c) => (
            <div key={c.slug} style={styles.creatureRow}>
              <img src={getCreatureIconUrl(c.name)} alt="" style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0 }} />
              <span style={styles.creatureName}>{c.name}</span>
              <div style={styles.countControls}>
                <button style={styles.countButton} onClick={() => updateCount(c.slug, -1)}>
                  <Minus size={10} />
                </button>
                <span style={styles.countValue}>x{c.count}</span>
                <button style={styles.countButton} onClick={() => updateCount(c.slug, 1)}>
                  <Plus size={10} />
                </button>
                <button
                  style={{ ...styles.countButton, color: theme.danger }}
                  onClick={() => removeCreature(c.slug)}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Total */}
        {creatures.length > 0 && (
          <div style={styles.totalRow}>
            Total: {creatures.reduce((sum, c) => sum + c.count, 0)} creatures
          </div>
        )}

        {/* Save button */}
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={handleSave}
          disabled={!encounterName.trim() || creatures.length === 0}
        >
          <Save size={14} style={{ marginRight: 6 }} />
          Save Encounter
        </Button>
      </div>
    );
  }

  // --- List Mode ---
  return (
    <div style={styles.container}>
      <Section title="Encounter Presets" emoji="⚔️">
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={() => setMode('build')}
        >
          <Plus size={14} style={{ marginRight: 6 }} />
          New Encounter
        </Button>
      </Section>

      {/* Spawn-zone selector. Lets the DM pick which zone the next
          deployment should drop into (defaults to map center). Only
          shown when at least one zone exists on the active map. */}
      {zones.length > 0 && (
        <div style={styles.zonePicker}>
          <label htmlFor="spawn-zone" style={styles.zonePickerLabel}>
            Spawn into:
          </label>
          <select
            id="spawn-zone"
            value={spawnZoneId ?? ''}
            onChange={(e) => setSpawnZoneId(e.target.value || null)}
            style={styles.zonePickerSelect}
          >
            <option value="">Map center (default)</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>
        </div>
      )}

      <Divider variant="plain" />

      {loading && (
        <div style={{ color: theme.text.muted, fontSize: 11, textAlign: 'center', padding: 12 }}>
          Loading...
        </div>
      )}

      {!loading && presets.length === 0 && (
        <div style={{ color: theme.text.muted, fontSize: 11, textAlign: 'center', padding: 16 }}>
          No encounters saved yet. Create one to deploy groups of creatures quickly.
        </div>
      )}

      <div style={styles.presetList}>
        {presets.map((preset) => (
          <div key={preset.id} style={styles.presetCard}>
            <div style={styles.presetHeader}>
              <span style={styles.presetName}>{preset.name}</span>
              <span style={styles.presetCount}>
                {preset.creatures.reduce((s: number, c: EncounterCreature) => s + c.count, 0)} creatures
              </span>
            </div>
            <div style={styles.presetCreatures}>
              {preset.creatures.map((c: EncounterCreature) => (
                <span key={c.slug} style={styles.creatureChip}>
                  {c.name} x{c.count}
                </span>
              ))}
            </div>
            <div style={styles.presetActions}>
              <button
                style={styles.deployButton}
                onClick={() => handleDeploy(preset.id)}
                disabled={!currentMap || deploying === preset.id}
              >
                <Play size={12} />
                {deploying === preset.id ? 'Deploying...' : 'Deploy'}
              </button>
              <button
                style={styles.deleteButton}
                onClick={() => handleDelete(preset.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function totalCreatureCount(creatures: EncounterCreature[]): number {
  return creatures.reduce((sum, c) => sum + c.count, 0);
}

// --- Styles ---

const styles: Record<string, React.CSSProperties & { zonePicker?: never }> = {
  zonePicker: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 4px',
  },
  zonePickerLabel: {
    fontSize: 12,
    color: theme.text.secondary,
    fontWeight: 600,
    flexShrink: 0,
  },
  zonePickerSelect: {
    flex: 1,
    padding: '4px 8px',
    fontSize: 12,
    background: theme.bg.deep,
    color: theme.text.primary,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    overflowY: 'auto',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  sectionTitle: {
    ...theme.type.h3,
    color: theme.gold.primary,
    margin: 0,
  },
  closeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.muted,
    cursor: 'pointer',
  },
  nameInput: {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    color: theme.text.primary,
    fontSize: 13,
    fontFamily: theme.font.body,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  searchInput: {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    color: theme.text.primary,
    fontSize: 12,
    fontFamily: theme.font.body,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  searchDropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    boxShadow: theme.shadow.md,
    zIndex: 20,
    maxHeight: 200,
    overflowY: 'auto' as const,
  },
  searchResult: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    color: theme.text.primary,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: theme.font.body,
    textAlign: 'left' as const,
    transition: `background ${theme.motion.fast}`,
  },
  searchResultName: {
    fontWeight: 600,
  },
  searchResultMeta: {
    fontSize: 10,
    color: theme.text.muted,
  },
  creatureList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    flex: 1,
    overflowY: 'auto' as const,
  },
  creatureRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
  },
  creatureName: {
    fontSize: 12,
    fontWeight: 600,
    color: theme.text.primary,
  },
  countControls: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  countButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    cursor: 'pointer',
    padding: 0,
  },
  countValue: {
    fontSize: 12,
    fontWeight: 700,
    color: theme.gold.primary,
    minWidth: 24,
    textAlign: 'center' as const,
  },
  totalRow: {
    fontSize: 11,
    fontWeight: 600,
    color: theme.text.secondary,
    textAlign: 'right' as const,
    padding: '4px 0',
  },
  presetList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  presetCard: {
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    padding: 10,
  },
  presetHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  presetName: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.text.primary,
  },
  presetCount: {
    fontSize: 10,
    color: theme.text.muted,
  },
  presetCreatures: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    marginBottom: 8,
  },
  creatureChip: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    background: theme.bg.elevated,
    border: `1px solid ${theme.border.default}`,
    borderRadius: 8,
    color: theme.text.secondary,
  },
  presetActions: {
    display: 'flex',
    gap: 6,
  },
  deployButton: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '6px 12px',
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.sm,
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  deleteButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.border.default}`,
    background: theme.bg.elevated,
    color: theme.text.muted,
    cursor: 'pointer',
  },
};
