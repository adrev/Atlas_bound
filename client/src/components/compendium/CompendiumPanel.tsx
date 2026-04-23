import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Plus } from 'lucide-react';
import { theme } from '../../styles/theme';
import { Button } from '../ui';
import { useSessionStore } from '../../stores/useSessionStore';
import { CompendiumDetailPopup } from './CompendiumDetailPopup';
import { CreateMonsterForm } from './CreateMonsterForm';
import { CreateSpellForm } from './CreateSpellForm';
import { CreateItemForm } from './CreateItemForm';
import type { CompendiumSearchResult, CompendiumCategory } from '@dnd-vtt/shared';
import { CONDITIONS } from '@dnd-vtt/shared';
import { SPELL_BUFFS } from './spellBuffsGlossary';
import { getCompendiumImageUrl, getCompendiumFallbackUrl } from '../../utils/compendiumIcons';
import { RULES_GLOSSARY } from './rulesGlossary';
import { FEATS } from './featsGlossary';
import { CLASSES } from './classesGlossary';
import { BACKGROUNDS } from './backgroundsGlossary';
import { RACES } from './racesGlossary';

type FilterCategory = 'all' | 'monsters' | 'spells' | 'items' | 'homebrew' | 'conditions' | 'rules' | 'feats' | 'classes' | 'backgrounds' | 'races';

// Wiki is a lookup surface for both DM + players — Homebrew lives
// under DM Tools (HomebrewPanel) so players don't see the authoring
// affordance. `homebrew` stays in the FilterCategory union so we can
// still pass it as the category programmatically from DM Tools.
const CATEGORY_FILTERS: { value: FilterCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'monsters', label: 'Monsters' },
  { value: 'spells', label: 'Spells' },
  { value: 'items', label: 'Items' },
  { value: 'classes', label: 'Classes' },
  { value: 'races', label: 'Races' },
  { value: 'backgrounds', label: 'Backgrounds' },
  { value: 'feats', label: 'Feats' },
  { value: 'conditions', label: 'Conditions' },
  { value: 'rules', label: 'Rules' },
];

const CATEGORY_BADGE_COLORS: Record<CompendiumCategory, string> = {
  monsters: '#c53131',
  spells: '#3498db',
  items: '#27ae60',
  conditions: '#e67e22',
  classes: '#9b59b6',
  races: '#1abc9c',
  feats: '#d4a843',
  backgrounds: '#b07942',
};

const RARITY_COLORS: Record<string, string> = {
  common: '#888',
  uncommon: '#27ae60',
  rare: '#3498db',
  very_rare: '#9b59b6',
  'very rare': '#9b59b6',
  legendary: '#e67e22',
  artifact: '#c0392b',
};

function spellLevelLabel(level: number): string {
  if (level === 0) return 'Cantrip';
  return `Lvl ${level}`;
}

export function CompendiumPanel({
  initialCategory = 'all',
  lockCategory = false,
}: {
  /** Start the panel on a specific tab (used by DM Tools → Homebrew). */
  initialCategory?: FilterCategory;
  /** Hide the category selector when the caller needs a fixed scope. */
  lockCategory?: boolean;
} = {}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FilterCategory>(initialCategory);
  const [results, setResults] = useState<CompendiumSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CompendiumSearchResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [createMode, setCreateMode] = useState<'monster' | 'spell' | 'item' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  /**
   * Sub-filter state. Rendered as a second row under the primary
   * category pills, scoped to whichever category is active.
   *
   *   spells   → level (0–9 or 'any') + school + class
   *   items    → rarity + type substring
   *   monsters → CR band + creature type substring
   *
   * All fields are optional; absence = "any". Reset whenever the
   * primary category changes.
   */
  const [spellLevel, setSpellLevel] = useState<number | 'any'>('any');
  const [spellSchool, setSpellSchool] = useState<string>('');
  const [spellClass, setSpellClass] = useState<string>('');
  const [itemRarity, setItemRarity] = useState<string>('');
  const [itemType, setItemType] = useState<string>('');
  const [monsterCrBand, setMonsterCrBand] = useState<string>('');
  const [monsterType, setMonsterType] = useState<string>('');
  // Reset sub-filters when the primary category changes so stale
  // state doesn't leak across tabs.
  useEffect(() => {
    setSpellLevel('any');
    setSpellSchool('');
    setSpellClass('');
    setItemRarity('');
    setItemType('');
    setMonsterCrBand('');
    setMonsterType('');
  }, [category]);

  const sessionId = useSessionStore((s) => s.sessionId);
  const isDM = useSessionStore((s) => s.isDM);
  const ruleSources = useSessionStore((s) => s.settings.ruleSources ?? ['phb']);
  // Memoize the Set so the effect deps stay stable across renders —
  // `ruleSources` is fresh on every render, but its content rarely
  // changes, so a stable-by-content comparison is what we want.
  const activeRuleSources = new Set(ruleSources);

  // Load default entries when no search
  useEffect(() => {
    if (query.trim()) return;
    setResults([]);
    setLoading(true);
    const cat = category;

    // Client-only rule references: conditions + rules glossary are
    // static data that live on the client, no server fetch needed.
    // The Conditions list surfaces the 15 standard 5e conditions AND
    // the common spell / class-feature pseudo-conditions (blessed,
    // raging, hasted, etc.) so players can look up what "Slowed" on
    // their token badge means.
    if (cat === 'conditions') {
      const real = CONDITIONS.map((c) => ({
        slug: c.name,
        name: c.label,
        category: 'conditions' as const,
        snippet: c.description,
      }));
      const buffs = SPELL_BUFFS.map((b) => ({
        slug: b.slug,
        name: b.name,
        category: 'conditions' as const,
        snippet: b.snippet,
      }));
      setResults([...real, ...buffs]);
      setLoading(false);
      return;
    }
    if (cat === 'rules') {
      setResults(RULES_GLOSSARY.map((r) => ({
        slug: r.slug,
        name: r.name,
        // CompendiumCategory doesn't include 'rules' yet; cast to the
        // nearest enum member so the badge renderer has a color. The
        // detail popup keys off slug for the rule glossary lookup.
        category: 'conditions' as const,
        snippet: r.snippet,
      })));
      setLoading(false);
      return;
    }
    // Filter client-side glossary entries by the DM's enabled rule
    // sources. PHB is always implicitly enabled. Entries without an
    // explicit source default to PHB, so the PHB-only default
    // session doesn't drop content.
    const isSourceEnabled = (src: string | undefined) =>
      (src ?? 'phb') === 'phb' || activeRuleSources.has(src as string);

    if (cat === 'feats') {
      setResults(FEATS.filter((f) => isSourceEnabled(f.source)).map((f) => ({
        slug: f.slug,
        name: f.name,
        category: 'feats' as const,
        snippet: f.prerequisite ? `${f.prerequisite} — ${f.snippet}` : f.snippet,
      })));
      setLoading(false);
      return;
    }
    if (cat === 'classes') {
      setResults(CLASSES.filter((c) => isSourceEnabled(c.source)).map((c) => ({
        slug: c.slug,
        name: c.name,
        category: 'classes' as const,
        snippet: `d${c.hitDie} HD · ${c.primaryAbility} · ${c.snippet}`,
      })));
      setLoading(false);
      return;
    }
    if (cat === 'races') {
      setResults(RACES.filter((r) => isSourceEnabled(r.source)).map((r) => ({
        slug: r.slug,
        name: r.name,
        // Races share the 'classes' badge color; no dedicated category
        // in the shared CompendiumCategory union yet.
        category: 'races' as const,
        snippet: `${r.size} · ${r.speed}ft · ${r.snippet}`,
      })));
      setLoading(false);
      return;
    }
    if (cat === 'backgrounds') {
      setResults(BACKGROUNDS.filter((b) => isSourceEnabled(b.source)).map((b) => ({
        slug: b.slug,
        name: b.name,
        category: 'backgrounds' as const,
        snippet: `${b.skills.join(', ')} · ${b.snippet}`,
      })));
      setLoading(false);
      return;
    }

    if (cat === 'homebrew') {
      // Fetch custom content from our session
      const sid = sessionId || 'default';
      Promise.all([
        fetch(`/api/custom/monsters?sessionId=${sid}`).then(r => r.json()).catch(() => []),
        fetch(`/api/custom/spells?sessionId=${sid}`).then(r => r.json()).catch(() => []),
        fetch(`/api/custom/items?sessionId=${sid}`).then(r => r.json()).catch(() => []),
      ]).then(([monsters, spells, items]) => {
        const results: CompendiumSearchResult[] = [];
        (monsters as any[]).forEach((m: any) => results.push({
          slug: m.slug, name: m.name, category: 'monsters',
          snippet: [m.size, m.type].filter(Boolean).join(' ') || 'Custom Monster',
          cr: m.challengeRating,
        }));
        (spells as any[]).forEach((s: any) => results.push({
          slug: s.slug, name: s.name, category: 'spells',
          snippet: [s.school, s.castingTime].filter(Boolean).join(' · ') || 'Custom Spell',
          level: s.level,
        }));
        (items as any[]).forEach((i: any) => results.push({
          slug: i.id || i.slug, name: i.name, category: 'items',
          snippet: [i.type, i.damage].filter(Boolean).join(' · ') || 'Custom Item',
          rarity: i.rarity as any,
        }));
        if (results.length === 0) {
          setResults([]);
        } else {
          setResults(results);
        }
        setLoading(false);
      });
      return;
    }

    if (cat === 'all') {
      Promise.all([
        fetch('/api/compendium/monsters?cr_min=0&cr_max=1&limit=10').then(r => r.json()).catch(() => []),
        fetch('/api/compendium/spells?level=0&limit=10').then(r => r.json()).catch(() => []),
        fetch('/api/compendium/items?rarity=common&limit=5').then(r => r.json()).catch(() => []),
      ]).then(([monsters, spells, items]) => {
        const results: CompendiumSearchResult[] = [];
        (monsters as any[]).slice(0, 8).forEach((m: any) => results.push({
          slug: m.slug, name: m.name, category: 'monsters', snippet: '', cr: m.challengeRating,
        }));
        (spells as any[]).slice(0, 8).forEach((s: any) => results.push({
          slug: s.slug, name: s.name, category: 'spells', snippet: '', level: s.level,
        }));
        (items as any[]).slice(0, 4).forEach((i: any) => results.push({
          slug: i.slug, name: i.name, category: 'items', snippet: '', rarity: i.rarity as any,
        }));
        setResults(results);
        setLoading(false);
      });
    } else {
      // Apply the active sub-filters to each endpoint's query string.
      // The server already supports these params — the sub-filter bar
      // just surfaces them in the UI.
      let endpoint: string;
      if (cat === 'monsters') {
        const qs = new URLSearchParams();
        qs.set('limit', '60');
        if (monsterType) qs.set('type', monsterType);
        // CR band format: "0-1" | "1-5" | "5-10" | "10-20" | "20+"
        if (monsterCrBand) {
          const [lo, hi] = monsterCrBand.split('-');
          if (lo) qs.set('cr_min', lo);
          if (hi && hi !== '+') qs.set('cr_max', hi);
        }
        endpoint = `/api/compendium/monsters?${qs}`;
      } else if (cat === 'spells') {
        const qs = new URLSearchParams();
        qs.set('limit', '120');
        if (spellLevel !== 'any') qs.set('level', String(spellLevel));
        if (spellSchool) qs.set('school', spellSchool);
        if (spellClass) qs.set('class', spellClass);
        endpoint = `/api/compendium/spells?${qs}`;
      } else {
        const qs = new URLSearchParams();
        qs.set('limit', '60');
        if (itemRarity) qs.set('rarity', itemRarity);
        endpoint = `/api/compendium/items?${qs}`;
      }
      fetch(endpoint).then(r => r.json()).then((data: any[]) => {
        let mapped = data.map((d: any) => ({
          slug: d.slug, name: d.name, category: cat as CompendiumCategory,
          snippet: cat === 'spells'
            ? [d.school, d.level === 0 ? 'Cantrip' : `L${d.level}`].filter(Boolean).join(' · ')
            : cat === 'monsters'
            ? [d.size, d.type, d.challengeRating ? `CR ${d.challengeRating}` : ''].filter(Boolean).join(' · ')
            : [d.type, d.rarity].filter(Boolean).join(' · '),
          cr: d.challengeRating, level: d.level, rarity: d.rarity,
          // Keep the original `type` around so we can post-filter items
          // by type substring (API doesn't support an item-type filter).
          _rawType: d.type as string | undefined,
        }));
        // Items: client-side type filter (API doesn't support it).
        if (cat === 'items' && itemType) {
          const needle = itemType.toLowerCase();
          mapped = mapped.filter((r) => (r._rawType ?? '').toLowerCase().includes(needle));
        }
        setResults(mapped);
        setLoading(false);
      }).catch(() => { setResults([]); setLoading(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, query, sessionId, refreshKey, ruleSources.join(','),
      spellLevel, spellSchool, spellClass,
      itemRarity, itemType,
      monsterCrBand, monsterType]);

  const fetchResults = useCallback((q: string, cat: FilterCategory) => {
    if (!q.trim()) return; // Default browse handles empty state

    setResults([]);
    setLoading(true);
    const sid = sessionId || 'default';
    const searchQ = q.trim().toLowerCase();

    if (cat === 'homebrew') {
      // Homebrew-only: search custom content, no SRD
      Promise.all([
        fetch(`/api/custom/monsters?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ))
            .map((m: any) => ({ slug: m.slug, name: m.name, category: 'monsters' as const, snippet: `Homebrew · ${m.size} ${m.type}`, cr: m.challengeRating }))),
        fetch(`/api/custom/spells?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ))
            .map((s: any) => ({ slug: s.slug, name: s.name, category: 'spells' as const, snippet: `Homebrew · ${s.school}`, level: s.level }))),
        fetch(`/api/custom/items?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ))
            .map((i: any) => ({ slug: i.id || i.slug, name: i.name, category: 'items' as const, snippet: `Homebrew · ${i.type}`, rarity: i.rarity }))),
      ]).then(([monsters, spells, items]) => {
        setResults([...monsters, ...spells, ...items]);
        setLoading(false);
      }).catch(() => {
        setResults([]);
        setLoading(false);
      });
      return;
    }

    const params = new URLSearchParams({ q: q.trim(), limit: '20' });
    if (cat !== 'all') params.set('category', cat);

    // Search SRD compendium + homebrew in parallel, merge results
    Promise.all([
      fetch(`/api/compendium/search?${params}`).then(r => r.json()).catch(() => ({ results: [] })),
      // Also search custom content matching the query
      ...(cat === 'all' || cat === 'monsters' ? [
        fetch(`/api/custom/monsters?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ)).slice(0, 5)
            .map((m: any) => ({ slug: m.slug, name: m.name, category: 'monsters' as const, snippet: `Homebrew · ${m.size} ${m.type}`, cr: m.challengeRating })))
      ] : []),
      ...(cat === 'all' || cat === 'spells' ? [
        fetch(`/api/custom/spells?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ)).slice(0, 5)
            .map((s: any) => ({ slug: s.slug, name: s.name, category: 'spells' as const, snippet: `Homebrew · ${s.school}`, level: s.level })))
      ] : []),
      ...(cat === 'all' || cat === 'items' ? [
        fetch(`/api/custom/items?sessionId=${sid}`).then(r => r.ok ? r.json() : [])
          .then((items: any[]) => items.filter((i: any) => i.name.toLowerCase().includes(searchQ)).slice(0, 5)
            .map((i: any) => ({ slug: i.id || i.slug, name: i.name, category: 'items' as const, snippet: `Homebrew · ${i.type}`, rarity: i.rarity })))
      ] : []),
    ]).then(([srdData, ...customArrays]) => {
      const customResults = customArrays.flat();
      // Homebrew first, then SRD
      setResults([...customResults, ...(srdData.results ?? [])]);
      setLoading(false);
    }).catch(() => {
      setResults([]);
      setLoading(false);
    });
  }, [sessionId]);

  // Debounced search on query change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchResults(query, category);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, category, fetchResults]);

  return (
    <div style={styles.container}>
      {/* Search bar */}
      <div style={styles.searchWrap}>
        <Search size={14} color={theme.text.muted} style={{ flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search monsters, spells, items..."
          style={styles.searchInput}
        />
      </div>

      {/* Category filter pills — hidden when the caller (DM Tools
          Homebrew entry) wants a fixed scope. */}
      {!lockCategory && (
        <div style={styles.pillRow}>
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.value}
              style={{
                ...styles.pill,
                ...(category === f.value ? styles.pillActive : {}),
              }}
              onClick={() => setCategory(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Secondary sub-filters — rendered per-category so the DM
          doesn't have to scroll through 300+ spells to find the L3
          evocation ones. Mirrors the wikidot.com "Spells by Level /
          by School / by Class" pattern.  */}
      {!lockCategory && !query.trim() && (
        <SubFilterBar
          category={category}
          spellLevel={spellLevel} setSpellLevel={setSpellLevel}
          spellSchool={spellSchool} setSpellSchool={setSpellSchool}
          spellClass={spellClass} setSpellClass={setSpellClass}
          itemRarity={itemRarity} setItemRarity={setItemRarity}
          itemType={itemType} setItemType={setItemType}
          monsterCrBand={monsterCrBand} setMonsterCrBand={setMonsterCrBand}
          monsterType={monsterType} setMonsterType={setMonsterType}
        />
      )}

      {/* Homebrew creation buttons */}
      {category === 'homebrew' && !createMode && (
        <div style={{
          display: 'flex', gap: 6, padding: '8px 12px',
          borderBottom: `1px solid ${theme.border.default}`,
          flexShrink: 0,
        }}>
          <Button variant="ghost" size="sm" leadingIcon={<Plus size={12} />}
            onClick={() => setCreateMode('monster')}
            style={{ flex: 1, color: theme.gold.primary, borderColor: theme.gold.border }}>
            New Monster
          </Button>
          <Button variant="ghost" size="sm" leadingIcon={<Plus size={12} />}
            onClick={() => setCreateMode('spell')}
            style={{ flex: 1, color: theme.gold.primary, borderColor: theme.gold.border }}>
            New Spell
          </Button>
          <Button variant="ghost" size="sm" leadingIcon={<Plus size={12} />}
            onClick={() => setCreateMode('item')}
            style={{ flex: 1, color: theme.gold.primary, borderColor: theme.gold.border }}>
            New Item
          </Button>
        </div>
      )}

      {/* Inline creation forms */}
      {createMode === 'monster' && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${theme.border.default}`, maxHeight: '60vh', overflowY: 'auto' }}>
          <CreateMonsterForm
            sessionId={sessionId || 'default'}
            onCreated={() => { setCreateMode(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCreateMode(null)}
          />
        </div>
      )}
      {createMode === 'spell' && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${theme.border.default}`, maxHeight: '60vh', overflowY: 'auto' }}>
          <CreateSpellForm
            sessionId={sessionId || 'default'}
            onCreated={() => { setCreateMode(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCreateMode(null)}
          />
        </div>
      )}
      {createMode === 'item' && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${theme.border.default}`, maxHeight: '60vh', overflowY: 'auto' }}>
          <CreateItemForm
            sessionId={sessionId || 'default'}
            onCreated={() => { setCreateMode(null); setRefreshKey((k) => k + 1); }}
            onCancel={() => setCreateMode(null)}
          />
        </div>
      )}

      {/* Results list */}
      <div style={styles.resultsList}>
        {category === 'homebrew' && !loading && results.length === 0 && !createMode && (
          <div style={{ textAlign: 'center', padding: 24, color: theme.text.muted }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🔨</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text.secondary, marginBottom: 4 }}>No Homebrew Content Yet</div>
            <div style={{ fontSize: 11 }}>Use the buttons above to create custom monsters or spells.</div>
          </div>
        )}

        {loading && query.trim() && (
          <p style={styles.hintText}>Searching...</p>
        )}

        {!loading && query.trim() && results.length === 0 && (
          <p style={styles.hintText}>No results found.</p>
        )}

        {results.map((r) => {
          // DMs can drag monster entries onto the battlemap. BattleMap
          // listens for application/x-kbrt-creature drops (see the
          // handler in BattleMap.tsx) and dispatches kbrt-creature-drop;
          // CreatureLibrary fetches by slug and calls handleAddToMap.
          // We reuse that exact plumbing here — nothing else needed.
          const isDraggable = isDM && r.category === 'monsters';
          return (
          <button
            key={`${r.category}-${r.slug}`}
            style={styles.resultItem}
            onClick={() => setSelected(r)}
            draggable={isDraggable}
            onDragStart={isDraggable ? (e) => {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('application/x-kbrt-creature', r.slug);
              e.dataTransfer.setData('text/plain', r.name);
            } : undefined}
            title={isDraggable ? 'Drag onto the map to place' : undefined}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = theme.bg.hover;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img
                src={getCompendiumImageUrl(r.slug, r.category)}
                alt=""
                loading="lazy"
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: `1.5px solid ${theme.border.default}` }}
                onError={(e) => { (e.currentTarget).src = getCompendiumFallbackUrl(r.name, r.category, r.snippet); }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.resultTop}>
                  <span
                    style={{
                      ...styles.categoryBadge,
                      background: `${CATEGORY_BADGE_COLORS[r.category] ?? '#888'}22`,
                      color: CATEGORY_BADGE_COLORS[r.category] ?? '#888',
                      borderColor: `${CATEGORY_BADGE_COLORS[r.category] ?? '#888'}44`,
                    }}
                  >
                    {r.category === 'monsters' ? 'Monster'
                      : r.category === 'spells' ? 'Spell'
                      : r.category === 'items' ? 'Item'
                      : r.category === 'classes' ? 'Class'
                      : r.category === 'races' ? 'Race'
                      : r.category === 'backgrounds' ? 'Background'
                      : r.category === 'feats' ? 'Feat'
                      : r.category === 'conditions'
                        // Rules, backgrounds, and spell-buffs all ride
                        // the 'conditions' badge color. Pick the right
                        // label by looking up the slug against each
                        // glossary so "Advantage & Disadvantage" reads
                        // as "Rule" and "Acolyte" reads as "Background".
                        ? (RULES_GLOSSARY.some((x) => x.slug === r.slug) ? 'Rule'
                          : BACKGROUNDS.some((x) => x.slug === r.slug) ? 'Background'
                          : 'Condition')
                      : 'Item'}
                  </span>
                  <span style={styles.resultName}>{r.name}</span>
                  <span style={styles.resultMeta}>
                    {r.category === 'monsters' && r.cr != null && `CR ${r.cr}`}
                    {r.category === 'spells' && r.level != null && spellLevelLabel(r.level)}
                    {r.category === 'items' && r.rarity && (
                      <span style={{ color: RARITY_COLORS[r.rarity.toLowerCase()] ?? '#888' }}>
                        {r.rarity}
                      </span>
                    )}
                  </span>
                </div>
                {r.snippet && (
                  <p style={styles.resultSnippet}>{r.snippet}</p>
                )}
              </div>
            </div>
          </button>
          );
        })}
      </div>

      {/* Detail popup */}
      {selected && (
        <CompendiumDetailPopup
          result={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  searchWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '12px 12px 0',
    padding: '8px 10px',
    background: theme.bg.deepest,
    border: `1px solid ${theme.gold.border}`,
    borderRadius: theme.radius.md,
    boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.4)',
  },
  searchInput: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: theme.text.primary,
    fontSize: 13,
    fontFamily: theme.font.body,
  },
  pillRow: {
    display: 'flex',
    gap: 4,
    padding: '10px 12px 0',
    flexShrink: 0,
    // 10 category pills on a narrow sidebar overflow horizontally
    // without wrap. Wrap keeps every pill in view; `rowGap` adds
    // breathing room when pills wrap to a second line so the two
    // rows don't crowd each other.
    flexWrap: 'wrap',
    rowGap: 6,
  },
  pill: {
    // Tighter padding + smaller font so more pills fit per row on
    // narrow sidebars before wrapping kicks in.
    padding: '3px 9px',
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 12,
    border: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.muted,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  pillActive: {
    background: 'rgba(197, 49, 49, 0.15)',
    color: '#e05555',
    borderColor: 'rgba(197, 49, 49, 0.4)',
  },
  resultsList: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 8px',
    minHeight: 0,
  },
  hintText: {
    color: theme.text.muted,
    fontSize: 13,
    textAlign: 'center',
    padding: '24px 12px',
    margin: 0,
  },
  resultItem: {
    display: 'block',
    width: '100%',
    padding: '8px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: theme.radius.sm,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.1s ease',
  },
  resultTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  categoryBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 8,
    border: '1px solid',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    flexShrink: 0,
  },
  resultName: {
    fontSize: 13,
    fontWeight: 600,
    color: theme.text.primary,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  resultMeta: {
    fontSize: 11,
    color: theme.text.muted,
    flexShrink: 0,
  },
  resultSnippet: {
    fontSize: 11,
    color: theme.text.muted,
    margin: '3px 0 0',
    lineHeight: 1.4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
};

// ═══════════════════════════════════════════════════════════════════
// Sub-filter constants — wikidot.com-style secondary indexing.
// ═══════════════════════════════════════════════════════════════════

const SPELL_LEVELS: Array<{ v: number | 'any'; label: string }> = [
  { v: 'any', label: 'All' },
  { v: 0, label: 'Cantrip' },
  { v: 1, label: '1' }, { v: 2, label: '2' }, { v: 3, label: '3' },
  { v: 4, label: '4' }, { v: 5, label: '5' }, { v: 6, label: '6' },
  { v: 7, label: '7' }, { v: 8, label: '8' }, { v: 9, label: '9' },
];

const SPELL_SCHOOLS = [
  'Abjuration', 'Conjuration', 'Divination', 'Enchantment',
  'Evocation', 'Illusion', 'Necromancy', 'Transmutation',
];

const SPELL_CLASSES = [
  'Artificer', 'Bard', 'Cleric', 'Druid', 'Paladin',
  'Ranger', 'Sorcerer', 'Warlock', 'Wizard',
];

const ITEM_RARITIES: Array<{ v: string; label: string; color: string }> = [
  { v: 'common', label: 'Common', color: '#888' },
  { v: 'uncommon', label: 'Uncommon', color: '#27ae60' },
  { v: 'rare', label: 'Rare', color: '#3498db' },
  { v: 'very_rare', label: 'Very Rare', color: '#9b59b6' },
  { v: 'legendary', label: 'Legendary', color: '#e67e22' },
  { v: 'artifact', label: 'Artifact', color: '#c0392b' },
];

const ITEM_TYPES = [
  'Weapon', 'Armor', 'Shield', 'Wondrous item', 'Potion', 'Scroll',
  'Wand', 'Rod', 'Staff', 'Ring', 'Ammunition', 'Tool',
];

const CR_BANDS: Array<{ v: string; label: string }> = [
  { v: '0-1', label: '0–1 (warm-up)' },
  { v: '1-5', label: '1–5 (tier 1)' },
  { v: '5-10', label: '5–10 (tier 2)' },
  { v: '10-20', label: '10–20 (tier 3)' },
  { v: '20-+', label: '20+ (tier 4)' },
];

const MONSTER_TYPES = [
  'Aberration', 'Beast', 'Celestial', 'Construct', 'Dragon',
  'Elemental', 'Fey', 'Fiend', 'Giant', 'Humanoid', 'Monstrosity',
  'Ooze', 'Plant', 'Undead',
];

interface SubFilterBarProps {
  category: FilterCategory;
  spellLevel: number | 'any'; setSpellLevel: (v: number | 'any') => void;
  spellSchool: string; setSpellSchool: (v: string) => void;
  spellClass: string; setSpellClass: (v: string) => void;
  itemRarity: string; setItemRarity: (v: string) => void;
  itemType: string; setItemType: (v: string) => void;
  monsterCrBand: string; setMonsterCrBand: (v: string) => void;
  monsterType: string; setMonsterType: (v: string) => void;
}

/**
 * Secondary filter row. Renders a different control set depending on
 * the active primary category. Mirrors the wikidot.com pattern of
 * "by Level / by School / by Class" for spells + "by Rarity / by
 * Type" for items + "by CR / by Type" for monsters.
 *
 * Returns null for categories without a sub-filter (classes / races /
 * backgrounds / feats / conditions / rules / homebrew / all) so the
 * UI stays flat for small lists where a secondary index would be
 * noise.
 */
function SubFilterBar(p: SubFilterBarProps) {
  if (p.category === 'spells') {
    return (
      <div style={subStyles.wrap}>
        <div style={subStyles.row}>
          {SPELL_LEVELS.map((lvl) => (
            <button
              key={String(lvl.v)}
              onClick={() => p.setSpellLevel(lvl.v)}
              style={{ ...subStyles.chip, ...(p.spellLevel === lvl.v ? subStyles.chipActive : {}) }}
            >
              {lvl.label}
            </button>
          ))}
        </div>
        <div style={subStyles.row}>
          <label style={subStyles.label}>School</label>
          <select
            value={p.spellSchool}
            onChange={(e) => p.setSpellSchool(e.target.value)}
            style={subStyles.select}
          >
            <option value="">Any</option>
            {SPELL_SCHOOLS.map((s) => (<option key={s} value={s.toLowerCase()}>{s}</option>))}
          </select>
          <label style={subStyles.label}>Class</label>
          <select
            value={p.spellClass}
            onChange={(e) => p.setSpellClass(e.target.value)}
            style={subStyles.select}
          >
            <option value="">Any</option>
            {SPELL_CLASSES.map((c) => (<option key={c} value={c.toLowerCase()}>{c}</option>))}
          </select>
        </div>
      </div>
    );
  }
  if (p.category === 'items') {
    return (
      <div style={subStyles.wrap}>
        <div style={subStyles.row}>
          {ITEM_RARITIES.map((r) => {
            const active = p.itemRarity === r.v;
            return (
              <button
                key={r.v}
                onClick={() => p.setItemRarity(active ? '' : r.v)}
                style={{
                  ...subStyles.chip,
                  ...(active ? {
                    ...subStyles.chipActive,
                    background: `${r.color}22`,
                    borderColor: `${r.color}66`,
                    color: r.color,
                  } : {}),
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <div style={subStyles.row}>
          <label style={subStyles.label}>Type</label>
          <select
            value={p.itemType}
            onChange={(e) => p.setItemType(e.target.value)}
            style={subStyles.select}
          >
            <option value="">Any</option>
            {ITEM_TYPES.map((t) => (<option key={t} value={t.toLowerCase()}>{t}</option>))}
          </select>
        </div>
      </div>
    );
  }
  if (p.category === 'monsters') {
    return (
      <div style={subStyles.wrap}>
        <div style={subStyles.row}>
          {CR_BANDS.map((b) => (
            <button
              key={b.v}
              onClick={() => p.setMonsterCrBand(p.monsterCrBand === b.v ? '' : b.v)}
              style={{ ...subStyles.chip, ...(p.monsterCrBand === b.v ? subStyles.chipActive : {}) }}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div style={subStyles.row}>
          <label style={subStyles.label}>Type</label>
          <select
            value={p.monsterType}
            onChange={(e) => p.setMonsterType(e.target.value)}
            style={subStyles.select}
          >
            <option value="">Any</option>
            {MONSTER_TYPES.map((t) => (<option key={t} value={t.toLowerCase()}>{t}</option>))}
          </select>
        </div>
      </div>
    );
  }
  return null;
}

const subStyles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '8px 12px 10px',
    borderBottom: `1px solid ${theme.border.default}`,
    flexShrink: 0,
    background: theme.bg.deep,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap' as const,
    rowGap: 4,
  },
  chip: {
    padding: '3px 8px',
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: '0.04em',
    borderRadius: 10,
    border: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.muted,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  chipActive: {
    background: 'rgba(212, 168, 67, 0.16)',
    borderColor: 'rgba(212, 168, 67, 0.5)',
    color: theme.gold.primary,
  },
  label: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: theme.text.muted,
    marginLeft: 4,
  },
  select: {
    padding: '3px 6px',
    fontSize: 11,
    background: theme.bg.elevated,
    color: theme.text.primary,
    border: `1px solid ${theme.border.default}`,
    borderRadius: 4,
    cursor: 'pointer',
    outline: 'none',
    fontFamily: theme.font.body,
  },
};
