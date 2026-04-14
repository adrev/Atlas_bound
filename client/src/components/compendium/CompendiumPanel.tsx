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
import { getCompendiumImageUrl, getCompendiumFallbackUrl } from '../../utils/compendiumIcons';

type FilterCategory = 'all' | 'monsters' | 'spells' | 'items' | 'homebrew';

const CATEGORY_FILTERS: { value: FilterCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'monsters', label: 'Monsters' },
  { value: 'spells', label: 'Spells' },
  { value: 'items', label: 'Items' },
  { value: 'homebrew', label: 'Homebrew' },
];

const CATEGORY_BADGE_COLORS: Record<CompendiumCategory, string> = {
  monsters: '#c53131',
  spells: '#3498db',
  items: '#27ae60',
  conditions: '#e67e22',
  classes: '#9b59b6',
  races: '#1abc9c',
  feats: '#d4a843',
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

export function CompendiumPanel() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FilterCategory>('all');
  const [results, setResults] = useState<CompendiumSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CompendiumSearchResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [createMode, setCreateMode] = useState<'monster' | 'spell' | 'item' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const sessionId = useSessionStore((s) => s.sessionId);

  // Load default entries when no search
  useEffect(() => {
    if (query.trim()) return;
    setResults([]);
    setLoading(true);
    const cat = category;

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
      const endpoint = cat === 'monsters' ? '/api/compendium/monsters?limit=30'
        : cat === 'spells' ? '/api/compendium/spells?limit=30'
        : '/api/compendium/items?limit=30';
      fetch(endpoint).then(r => r.json()).then((data: any[]) => {
        setResults(data.map((d: any) => ({
          slug: d.slug, name: d.name, category: cat as CompendiumCategory,
          snippet: '', cr: d.challengeRating, level: d.level, rarity: d.rarity,
        })));
        setLoading(false);
      }).catch(() => { setResults([]); setLoading(false); });
    }
  }, [category, query, sessionId, refreshKey]);

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

      {/* Category filter pills */}
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

        {results.map((r) => (
          <button
            key={`${r.category}-${r.slug}`}
            style={styles.resultItem}
            onClick={() => setSelected(r)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = theme.bg.hover;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img
                src={getCompendiumImageUrl(r.name, r.category)}
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
                    {r.category === 'monsters' ? 'Monster' : r.category === 'spells' ? 'Spell' : 'Item'}
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
        ))}
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
    gap: 6,
    padding: '10px 12px 0',
    flexShrink: 0,
  },
  pill: {
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 12,
    border: `1px solid ${theme.border.default}`,
    background: 'transparent',
    color: theme.text.muted,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
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
