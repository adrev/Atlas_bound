import { useState, useEffect, useCallback, useRef } from 'react';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { emitTokenAdd } from '../../socket/emitters';
import { theme } from '../../styles/theme';
import type { CompendiumMonster } from '@dnd-vtt/shared';
import { getCreatureImageUrl, getCreatureImageSvgUrl, getCreatureIconUrl } from '../../utils/compendiumIcons';
import { splitCommaList, accentForSense, accentForLanguage, SENSE_LANG_CHIP_BASE } from '../../utils/senseLanguageChips';

// --- Helpers ---

/** PNG art URL (GCS-hosted) */
function getCreatureImagePng(name: string): string {
  return getCreatureImageUrl(name);
}
/** SVG fallback URL (GCS-hosted) */
function getCreatureImageSvg(name: string): string {
  return getCreatureImageSvgUrl(name);
}
/** Best image URL for spawning tokens */
function getCreatureTokenUrl(monster: CompendiumMonster): string {
  // DB slug, not name — slugify(name) doesn't round-trip for names
  // with apostrophes or edition suffixes (e.g. "Black Goat's
  // Blessing" → "black-goat-s-blessing" vs DB "black-goats-blessing").
  return getCreatureImageUrl(monster.slug);
}

function getRecommendedLevel(cr: number): string {
  if (cr <= 0.25) return 'Lv 1-2';
  if (cr <= 0.5) return 'Lv 1-3';
  if (cr <= 1) return 'Lv 1-4';
  if (cr <= 2) return 'Lv 2-5';
  if (cr <= 3) return 'Lv 3-6';
  if (cr <= 5) return 'Lv 4-8';
  if (cr <= 8) return 'Lv 6-11';
  if (cr <= 11) return 'Lv 8-14';
  if (cr <= 15) return 'Lv 11-17';
  if (cr <= 20) return 'Lv 15-20';
  return 'Lv 17-20+';
}

function getDifficultyColor(cr: number): string {
  if (cr <= 0.5) return '#27ae60';
  if (cr <= 2) return '#f1c40f';
  if (cr <= 5) return '#e67e22';
  if (cr <= 10) return '#e74c3c';
  return '#9b59b6';
}

function formatCR(cr: string | number): string {
  const n = typeof cr === 'string' ? parseFloat(cr) : cr;
  if (n === 0.125) return '1/8';
  if (n === 0.25) return '1/4';
  if (n === 0.5) return '1/2';
  if (n === 0) return '0';
  return String(n);
}

// Size -> token grid size mapping
const SIZE_MAP: Record<string, number> = {
  Tiny: 0.5, tiny: 0.5,
  Small: 1, small: 1,
  Medium: 1, medium: 1,
  Large: 2, large: 2,
  Huge: 3, huge: 3,
  Gargantuan: 4, gargantuan: 4,
};

// Type color for visual variety
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

// ── Action preview helpers ─────────────────────────────────────
// Some sources (A5E, homebrew) don't split attack_bonus +
// damage_dice into structured fields — the info lives inside the
// freeform `desc` text. extractAttackStats falls back to regex when
// the structured fields are absent so the preview card shows useful
// numbers instead of just bare action names.

interface MonsterActionShape {
  name: string;
  desc?: string;
  attack_bonus?: number;
  damage_dice?: string;
}

function extractAttackStats(a: MonsterActionShape): {
  attackBonus: number | null;
  damage: string | null;
  summary: string | null;
} {
  // Structured wins.
  if (a.attack_bonus != null || a.damage_dice) {
    return {
      attackBonus: a.attack_bonus ?? null,
      damage: a.damage_dice ?? null,
      summary: null,
    };
  }
  const desc = a.desc ?? '';
  // "Melee Weapon Attack: +X to hit" / "Ranged Weapon Attack: +X to hit"
  const hitMatch = desc.match(/([+-]\d+)\s+to\s+hit/i);
  // "Hit: NdM+K bludgeoning/piercing/slashing/… damage"
  const dmgMatch = desc.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*(?:\([^)]*\))?\s*\b(?:bludgeoning|piercing|slashing|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)?\s*damage/i);
  const attackBonus = hitMatch ? parseInt(hitMatch[1], 10) : null;
  const damage = dmgMatch ? dmgMatch[1].replace(/\s+/g, '') : null;
  // Summary fallback: first phrase of the description, capped so
  // the preview card doesn't grow unbounded for long actions.
  let summary: string | null = null;
  if (!attackBonus && !damage) {
    const trimmed = desc.replace(/\*\*/g, '').trim();
    const firstSentence = trimmed.split(/[.!?]\s/, 1)[0];
    summary = firstSentence.length > 60 ? firstSentence.slice(0, 57) + '…' : firstSentence;
    if (!summary) summary = null;
  }
  return { attackBonus, damage, summary };
}

// --- Filter options ---

const TYPE_OPTIONS = [
  'All', 'Aberration', 'Beast', 'Celestial', 'Construct', 'Dragon',
  'Elemental', 'Fey', 'Fiend', 'Giant', 'Humanoid', 'Monstrosity',
  'Ooze', 'Plant', 'Undead',
];

type CRRange = 'all' | '0-1' | '2-5' | '6-10' | '11+';

const CR_OPTIONS: Array<{ label: string; value: CRRange }> = [
  { label: 'All CR', value: 'all' },
  { label: 'CR 0-1', value: '0-1' },
  { label: 'CR 2-5', value: '2-5' },
  { label: 'CR 6-10', value: '6-10' },
  { label: 'CR 11+', value: '11+' },
];

function getCRParams(range: CRRange): { cr_min?: number; cr_max?: number } {
  switch (range) {
    case '0-1': return { cr_min: 0, cr_max: 1 };
    case '2-5': return { cr_min: 2, cr_max: 5 };
    case '6-10': return { cr_min: 6, cr_max: 10 };
    case '11+': return { cr_min: 11 };
    default: return {};
  }
}

// --- Component ---

export function CreatureLibrary() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [crFilter, setCrFilter] = useState<CRRange>('all');
  const [monsters, setMonsters] = useState<CompendiumMonster[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalHint, setTotalHint] = useState<string>('');
  const currentMap = useMapStore((s) => s.currentMap);
  const abortRef = useRef<AbortController | null>(null);

  const PAGE_SIZE = 40;

  // Fetch monsters from compendium API
  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const fetchMonsters = async () => {
      setLoading(true);
      setMonsters([]);
      try {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        if (typeFilter !== 'All') params.set('type', typeFilter);
        const crParams = getCRParams(crFilter);
        if (crParams.cr_min !== undefined) params.set('cr_min', String(crParams.cr_min));
        if (crParams.cr_max !== undefined) params.set('cr_max', String(crParams.cr_max));

        let url: string;
        if (search.trim().length >= 2) {
          // Search SRD compendium + homebrew custom monsters in parallel
          const sid = useSessionStore.getState().sessionId || 'default';
          const [srdData, customAll] = await Promise.all([
            fetch(`/api/compendium/search?q=${encodeURIComponent(search.trim())}&category=monsters&limit=20`, { signal: controller.signal })
              .then(r => r.ok ? r.json() : { results: [] }),
            fetch(`/api/custom/monsters?sessionId=${sid}`, { signal: controller.signal })
              .then(r => r.ok ? r.json() : []),
          ]);
          const srdSlugs: string[] = (srdData.results || []).map((r: { slug: string }) => r.slug);
          // Filter custom monsters by search query
          const q = search.trim().toLowerCase();
          const customMatches = (customAll as CompendiumMonster[]).filter(
            (m: any) => m.name.toLowerCase().includes(q)
          );
          if (srdSlugs.length === 0 && customMatches.length === 0) {
            setMonsters([]);
            setTotalHint('0 results');
            setLoading(false);
            return;
          }
          // Fetch full SRD data in small batches of 5
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
          setMonsters(fullMonsters);
          setTotalHint(`${fullMonsters.length} result${fullMonsters.length !== 1 ? 's' : ''}`);
        } else {
          url = `/api/compendium/monsters?${params.toString()}`;
          const resp = await fetch(url, { signal: controller.signal });
          if (!resp.ok) throw new Error('Failed to fetch');
          const data = await resp.json() as CompendiumMonster[];
          setMonsters(data);
          setTotalHint(`${data.length} creature${data.length !== 1 ? 's' : ''}`);
        }
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') {
          setMonsters([]);
          setTotalHint('Error loading');
        }
      }
      setLoading(false);
    };

    const delay = search.trim().length >= 2 ? 300 : 0;
    const timeout = setTimeout(fetchMonsters, delay);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [search, typeFilter, crFilter]);

  // Load more on scroll
  const loadMore = useCallback(async () => {
    if (loading || search.trim().length >= 2) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(monsters.length));
      if (typeFilter !== 'All') params.set('type', typeFilter);
      const crParams = getCRParams(crFilter);
      if (crParams.cr_min !== undefined) params.set('cr_min', String(crParams.cr_min));
      if (crParams.cr_max !== undefined) params.set('cr_max', String(crParams.cr_max));
      const resp = await fetch(`/api/compendium/monsters?${params.toString()}`);
      if (resp.ok) {
        const data = await resp.json() as CompendiumMonster[];
        if (data.length > 0) {
          setMonsters(prev => [...prev, ...data]);
          setTotalHint(`${monsters.length + data.length}+ creatures`);
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [loading, search, typeFilter, crFilter, monsters.length]);

  // Listen for creature drops dispatched by the BattleMap. We fetch
  // the monster by slug (not always in the current paginated list)
  // and route through the shared handleAddToMap below with the drop
  // coordinates in map-space.
  useEffect(() => {
    const onDrop = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { slug: string; x: number; y: number } | undefined;
      if (!detail?.slug) return;
      try {
        const r = await fetch(`/api/compendium/monsters/${detail.slug}`);
        if (!r.ok) return;
        const monster = (await r.json()) as CompendiumMonster;
        handleAddToMap(monster, { x: detail.x, y: detail.y });
      } catch {
        // Non-fatal — user can retry via the Add to Map button.
      }
    };
    window.addEventListener('kbrt-creature-drop', onDrop);
    return () => window.removeEventListener('kbrt-creature-drop', onDrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMap?.id]);

  const handleAddToMap = useCallback(
    async (monster: CompendiumMonster, dropPos?: { x: number; y: number }) => {
      if (!currentMap) return;

      const walkSpeed = monster.speed?.walk ?? 30;
      const tokenColor = getTokenColor(monster.type);
      const gridSize = SIZE_MAP[monster.size] ?? 1;
      const tokenX = dropPos?.x ?? currentMap.width / 2;
      const tokenY = dropPos?.y ?? currentMap.height / 2;

      try {
        // Create character record from compendium data
        const resp = await fetch('/api/characters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isNpc: true,
            name: monster.name,
            race: monster.type,
            class: `CR ${formatCR(monster.challengeRating)}`,
            level: Math.max(1, Math.ceil(monster.crNumeric)),
            hitPoints: monster.hitPoints,
            maxHitPoints: monster.hitPoints,
            armorClass: monster.armorClass,
            speed: walkSpeed,
            abilityScores: monster.abilityScores,
            proficiencyBonus: Math.max(2, Math.floor((monster.crNumeric - 1) / 4) + 2),
            portraitUrl: getCreatureTokenUrl(monster),
            compendiumSlug: monster.slug,
          }),
        });
        const charData = await resp.json();
        const characterId = charData?.id || null;

        if (characterId && charData) {
          const { useCharacterStore } = await import('../../stores/useCharacterStore');
          useCharacterStore.getState().setAllCharacters({
            ...useCharacterStore.getState().allCharacters,
            [characterId]: charData,
          });
        }

        emitTokenAdd({
          mapId: currentMap.id,
          characterId,
          name: monster.name,
          x: tokenX,
          y: tokenY,
          size: gridSize,
          imageUrl: getCreatureTokenUrl(monster),
          color: tokenColor,
          layer: 'token',
          visible: true,
          hasLight: false,
          lightRadius: 140,
          lightDimRadius: 280,
          lightColor: '#ffcc66',
          conditions: [],
          ownerUserId: null,
          faction: 'hostile',
        });
      } catch {
        // Fallback without character record
        emitTokenAdd({
          mapId: currentMap.id,
          characterId: null,
          name: monster.name,
          x: tokenX,
          y: tokenY,
          size: gridSize,
          imageUrl: getCreatureTokenUrl(monster),
          color: getTokenColor(monster.type),
          layer: 'token',
          visible: true,
          hasLight: false,
          lightRadius: 140,
          lightDimRadius: 280,
          lightColor: '#ffcc66',
          conditions: [],
          ownerUserId: null,
          faction: 'hostile',
        });
      }
    },
    [currentMap],
  );

  return (
    <div style={styles.container}>
      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search 3200+ creatures..."
        style={styles.searchInput}
      />

      {/* Type filter chips */}
      <div style={styles.chipRow}>
        {TYPE_OPTIONS.map((t) => (
          <button
            key={t}
            style={{
              ...styles.chip,
              ...(typeFilter === t ? styles.chipActive : {}),
            }}
            onClick={() => setTypeFilter(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {/* CR filter chips */}
      <div style={styles.chipRow}>
        {CR_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            style={{
              ...styles.chip,
              ...(crFilter === opt.value ? styles.chipActive : {}),
            }}
            onClick={() => setCrFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Results count */}
      <div style={styles.resultCount}>
        {loading ? 'Loading...' : totalHint}
      </div>

      {/* Creature cards */}
      <div style={styles.cardList}>
        {monsters.map((monster) => (
          <CreatureCard
            key={monster.slug}
            monster={monster}
            onAdd={handleAddToMap}
            disabled={!currentMap}
          />
        ))}
        {!loading && monsters.length === 0 && search.length >= 2 && (
          <div style={{ textAlign: 'center', color: theme.text.muted, fontSize: 12, padding: 20 }}>
            No creatures found for "{search}"
          </div>
        )}
        {!loading && monsters.length >= PAGE_SIZE && search.trim().length < 2 && (
          <button onClick={loadMore} style={styles.loadMoreButton}>
            Load More
          </button>
        )}
        {loading && monsters.length > 0 && (
          <div style={{ textAlign: 'center', color: theme.text.muted, fontSize: 11, padding: 8 }}>
            Loading...
          </div>
        )}
      </div>
    </div>
  );
}

// --- Card Component ---

function CreatureCard({
  monster,
  onAdd,
  disabled,
}: {
  monster: CompendiumMonster;
  onAdd: (m: CompendiumMonster, dropPos?: { x: number; y: number }) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const cr = monster.crNumeric;
  const walkSpeed = monster.speed?.walk ?? 30;
  const [imgSrc, setImgSrc] = useState(getCreatureImagePng(monster.slug));

  // Drag-to-map: set the slug on the dataTransfer so BattleMap's
  // drop handler can look it up. We intentionally use an app-specific
  // MIME type so stray drags from other pages / apps don't trigger
  // an accidental creature spawn.
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-kbrt-creature', monster.slug);
    e.dataTransfer.setData('text/plain', monster.name);
  };

  return (
    <div
      style={styles.card}
      draggable={!disabled}
      onDragStart={handleDragStart}
      title={disabled ? '' : 'Drag onto the map to place'}
    >
      <div style={styles.cardHeader} onClick={() => setExpanded(!expanded)}>
        {/* Token image: try PNG (real art) -> SVG (generated) -> initial fallback */}
        <div style={{ ...styles.tokenCircle, overflow: 'hidden', padding: 0, position: 'relative' }}>
          <img
            src={imgSrc}
            alt={monster.name}
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
            onError={(e) => {
              if (imgSrc.endsWith('.png')) {
                setImgSrc(getCreatureImageSvg(monster.slug));
              } else {
                const el = e.currentTarget;
                const parent = el.parentElement;
                if (!parent) return;
                el.style.display = 'none';
                const color = getTokenColor(monster.type);
                parent.style.backgroundColor = color;
                parent.textContent = '';
                const span = document.createElement('span');
                span.style.cssText = 'font-size:16px;font-weight:700;color:#fff';
                span.textContent = monster.name.charAt(0);
                parent.appendChild(span);
              }
            }}
          />
          {monster.tokenImageSource === 'generated' && (
            <div style={styles.generatedBadge} title="Placeholder — no artwork yet">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
          )}
        </div>

        {/* Info */}
        <div style={styles.cardInfo}>
          <div style={styles.cardName}>{monster.name}</div>
          <div style={styles.cardMeta}>
            <span style={styles.typeBadge}>{monster.type}</span>
            <span style={styles.crBadge}>CR {formatCR(monster.challengeRating)}</span>
            <span style={{
              ...styles.levelBadge,
              backgroundColor: getDifficultyColor(cr) + '22',
              color: getDifficultyColor(cr),
              borderColor: getDifficultyColor(cr) + '55',
            }}>
              {getRecommendedLevel(cr)}
            </span>
          </div>
        </div>

        {/* Stats summary */}
        <div style={styles.cardStats}>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>HP</span>
            <span style={styles.statValue}>{monster.hitPoints}</span>
          </div>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>AC</span>
            <span style={styles.statValue}>{monster.armorClass}</span>
          </div>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={styles.cardExpanded}>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Size:</span>
            <span style={styles.detailValue}>{monster.size}</span>
          </div>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Speed:</span>
            <span style={styles.detailValue}>
              {Object.entries(monster.speed || {}).map(([k, v]) => `${k} ${v} ft.`).join(', ') || `${walkSpeed} ft.`}
            </span>
          </div>
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Hit Dice:</span>
            <span style={styles.detailValue}>{monster.hitDice}</span>
          </div>
          {monster.alignment && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Alignment:</span>
              <span style={styles.detailValue}>{monster.alignment}</span>
            </div>
          )}
          {/* Senses + Languages as chip rows — the raw monster data
              stores these as a comma-joined string like
              "darkvision 60 ft., passive Perception 15". Splitting by
              comma + rendering each as a badge reads much better at
              card scale than running prose. */}
          {monster.senses && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Senses:</span>
              <span style={styles.detailChipRow}>
                {splitCommaList(monster.senses).map((s, i) => (
                  <span key={i} style={{ ...SENSE_LANG_CHIP_BASE, ...accentForSense(s) }}>{s}</span>
                ))}
              </span>
            </div>
          )}
          {monster.languages && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Languages:</span>
              <span style={styles.detailChipRow}>
                {splitCommaList(monster.languages).map((s, i) => (
                  <span key={i} style={{ ...SENSE_LANG_CHIP_BASE, ...accentForLanguage(s) }}>{s}</span>
                ))}
              </span>
            </div>
          )}

          {/* Ability scores */}
          <div style={styles.abilityScoresRow}>
            {(Object.entries(monster.abilityScores) as [string, number][]).map(
              ([key, val]) => (
                <div key={key} style={styles.abilityScore}>
                  <span style={styles.abilityLabel}>{key.toUpperCase()}</span>
                  <span style={styles.abilityValue}>{val}</span>
                  <span style={styles.abilityMod}>
                    {Math.floor((val - 10) / 2) >= 0 ? '+' : ''}
                    {Math.floor((val - 10) / 2)}
                  </span>
                </div>
              ),
            )}
          </div>

          {/* Actions preview. Structured attack_bonus + damage_dice
              are surfaced first when present. Falls back to
              extractAttackStats() (regex over `a.desc`) for monsters
              like Corrupted Unicorn / A5E content where the
              seed-time parser didn't split them out. Last resort:
              show a short description snippet so the card isn't a
              wall of bare action names. */}
          {monster.actions && monster.actions.length > 0 && (
            <div style={{ marginTop: 4, borderTop: `1px solid ${theme.border.default}`, paddingTop: 4 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: theme.gold.dim, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Actions
              </div>
              {monster.actions.slice(0, 4).map((a, i) => {
                const stats = extractAttackStats(a);
                return (
                  <div key={i} style={{ fontSize: 10, color: theme.text.secondary, padding: '1px 0' }}>
                    <span style={{ fontWeight: 600, color: theme.text.primary }}>{a.name}</span>
                    {stats.attackBonus != null && (
                      <span style={{ color: theme.text.muted }}> +{stats.attackBonus}</span>
                    )}
                    {stats.damage && (
                      <span style={{ color: theme.danger }}> ({stats.damage})</span>
                    )}
                    {!stats.attackBonus && !stats.damage && stats.summary && (
                      <span style={{ color: theme.text.muted }}> — {stats.summary}</span>
                    )}
                  </div>
                );
              })}
              {monster.actions.length > 4 && (
                <div style={{ fontSize: 9, color: theme.text.muted }}>+{monster.actions.length - 4} more</div>
              )}
            </div>
          )}

          {/* Source */}
          <div style={{ fontSize: 8, color: theme.text.muted, marginTop: 4, fontStyle: 'italic' }}>
            {monster.source}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={styles.cardActions}>
        <button
          style={styles.wikiButton}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('open-compendium-detail', {
              detail: { slug: monster.slug, category: 'monsters', name: monster.name },
            }));
          }}
        >
          View Full Stats
        </button>
        <button
          style={{
            ...styles.addButton,
            ...(disabled ? styles.addButtonDisabled : {}),
          }}
          onClick={(e) => {
            e.stopPropagation();
            onAdd(monster);
          }}
          disabled={disabled}
        >
          Add to Map
        </button>
      </div>
    </div>
  );
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    overflowY: 'auto',
    height: '100%',
  },
  searchInput: {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.sm,
    background: theme.bg.deep,
    color: theme.text.primary,
    fontSize: 13,
    fontFamily: theme.font.body,
    outline: 'none',
    boxSizing: 'border-box',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
  },
  chip: {
    padding: '3px 8px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: 12,
    background: theme.bg.elevated,
    color: theme.text.muted,
    fontSize: 10,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  },
  chipActive: {
    background: theme.gold.bg,
    borderColor: theme.gold.border,
    color: theme.gold.primary,
  },
  resultCount: {
    fontSize: 11,
    color: theme.text.muted,
    fontStyle: 'italic',
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  card: {
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    transition: 'border-color 0.15s',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    cursor: 'pointer',
  },
  tokenCircle: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    border: '2px solid rgba(255,255,255,0.15)',
    boxShadow: '0 0 6px rgba(0,0,0,0.4)',
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  cardName: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.text.primary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  typeBadge: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: theme.text.muted,
    background: theme.bg.elevated,
    padding: '1px 5px',
    borderRadius: 3,
  },
  crBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: theme.gold.dim,
  },
  levelBadge: {
    fontSize: 8,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    border: '1px solid',
  },
  cardStats: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
  },
  statLabel: {
    fontSize: 8,
    fontWeight: 700,
    color: theme.text.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statValue: {
    fontSize: 14,
    fontWeight: 700,
    color: theme.text.primary,
    fontFamily: theme.font.display,
  },
  cardExpanded: {
    padding: '6px 10px 8px',
    borderTop: `1px solid ${theme.border.default}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  detailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
  },
  detailLabel: {
    color: theme.text.muted,
  },
  detailValue: {
    color: theme.text.secondary,
    fontWeight: 600,
  },
  // Senses + Languages: chip layout so each distinct sense /
  // language stands apart visually instead of melting into a
  // comma-separated string that wraps awkwardly on narrow cards.
  detailChipRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 3,
    rowGap: 3,
    justifyContent: 'flex-end',
    flex: 1,
    marginLeft: 8,
  },
  abilityScoresRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 4,
    marginTop: 4,
    padding: '6px 0',
    borderTop: `1px solid ${theme.border.default}`,
  },
  abilityScore: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
  },
  abilityLabel: {
    fontSize: 8,
    fontWeight: 700,
    color: theme.gold.dim,
    letterSpacing: '0.05em',
  },
  abilityValue: {
    fontSize: 13,
    fontWeight: 700,
    color: theme.text.primary,
  },
  abilityMod: {
    fontSize: 9,
    color: theme.text.muted,
  },
  generatedBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: theme.bg.elevated,
    border: `1.5px solid ${theme.border.default}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.text.muted,
    fontSize: 7,
  },
  cardActions: {
    display: 'flex',
    borderTop: `1px solid ${theme.border.default}`,
  },
  wikiButton: {
    flex: 1,
    padding: '6px 12px',
    border: 'none',
    borderRight: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.secondary,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
    letterSpacing: '0.02em',
  },
  addButton: {
    flex: 1,
    padding: '6px 12px',
    border: 'none',
    background: theme.gold.bg,
    color: theme.gold.primary,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  addButtonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  loadMoreButton: {
    width: '100%',
    padding: '10px 12px',
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.md,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: theme.font.body,
    cursor: 'pointer',
    transition: 'all 0.15s',
    marginTop: 4,
  },
};
