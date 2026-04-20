import { useEffect, useState, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { theme } from '../../styles/theme';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { emitCharacterUpdate } from '../../socket/emitters';
import { resolveSpellSlug } from '../../utils/spell-aliases';
import { getCreatureIconUrl, getCreatureImageUrl, getCreatureImageSvgUrl, getSpellIconUrl, getSpellImageUrl, getItemIconUrl, getItemImageUrl } from '../../utils/compendiumIcons';
import type {
  CompendiumMonster,
  CompendiumSpell,
  CompendiumItem,
  CompendiumSearchResult,
} from '@dnd-vtt/shared';
import { CONDITION_MAP } from '@dnd-vtt/shared';
import { RULES_GLOSSARY } from './rulesGlossary';
import { FEATS } from './featsGlossary';
import { CLASSES } from './classesGlossary';
import { BACKGROUNDS } from './backgroundsGlossary';
import { RACES } from './racesGlossary';
import { SPELL_BUFFS } from './spellBuffsGlossary';

/** Renders markdown content with dark-theme styled tables, bold, lists, etc. */
function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div style={mdStyles.container}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <p style={mdStyles.p}>{children}</p>,
          strong: ({ children }) => <strong style={mdStyles.strong}>{children}</strong>,
          em: ({ children }) => <em style={mdStyles.em}>{children}</em>,
          ul: ({ children }) => <ul style={mdStyles.ul}>{children}</ul>,
          ol: ({ children }) => <ol style={mdStyles.ol}>{children}</ol>,
          li: ({ children }) => <li style={mdStyles.li}>{children}</li>,
          table: ({ children }) => (
            <div style={mdStyles.tableWrapper}>
              <table style={mdStyles.table}>{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead style={mdStyles.thead}>{children}</thead>,
          th: ({ children }) => <th style={mdStyles.th}>{children}</th>,
          td: ({ children }) => <td style={mdStyles.td}>{children}</td>,
          tr: ({ children }) => <tr style={mdStyles.tr}>{children}</tr>,
          h1: ({ children }) => <h3 style={mdStyles.heading}>{children}</h3>,
          h2: ({ children }) => <h3 style={mdStyles.heading}>{children}</h3>,
          h3: ({ children }) => <h4 style={mdStyles.heading}>{children}</h4>,
          hr: () => <hr style={mdStyles.hr} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const mdStyles: Record<string, React.CSSProperties> = {
  container: { fontSize: 13, lineHeight: 1.6, color: theme.text.secondary },
  p: { margin: '6px 0' },
  strong: { color: theme.text.primary, fontWeight: 600 },
  em: { color: theme.gold.dim, fontStyle: 'italic' },
  ul: { margin: '4px 0', paddingLeft: 20 },
  ol: { margin: '4px 0', paddingLeft: 20 },
  li: { margin: '2px 0' },
  tableWrapper: { overflowX: 'auto', margin: '8px 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
  thead: { background: 'rgba(212,168,67,0.1)' },
  th: { padding: '4px 8px', textAlign: 'left', borderBottom: `1px solid ${theme.border.default}`, color: theme.gold.dim, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '4px 8px', borderBottom: `1px solid ${theme.border.default}`, color: theme.text.secondary },
  tr: {},
  heading: { color: theme.text.primary, margin: '10px 0 4px', fontSize: 14, fontWeight: 700 },
  hr: { border: 'none', borderTop: `1px solid ${theme.border.default}`, margin: '8px 0' },
};

interface Props {
  result: CompendiumSearchResult;
  onClose: () => void;
}

const RARITY_COLORS: Record<string, string> = {
  common: '#888',
  uncommon: '#27ae60',
  rare: '#3498db',
  very_rare: '#9b59b6',
  'very rare': '#9b59b6',
  legendary: '#e67e22',
  artifact: '#c0392b',
};

const ABILITY_LABELS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
const ABILITY_KEYS: (keyof CompendiumMonster['abilityScores'])[] = [
  'str', 'dex', 'con', 'int', 'wis', 'cha',
];

function abilityMod(score: number): string {
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function formatSpeed(speed: Record<string, number>): string {
  return Object.entries(speed)
    .map(([type, val]) => (type === 'walk' ? `${val} ft.` : `${type} ${val} ft.`))
    .join(', ');
}

function getCreatureImage(_slug: string, name?: string, _type?: string): { svg: string; png: string } {
  // Prefer the DB slug — see notes on getSpellImage below for why
  // slugify(name) isn't round-trip-safe. Name/type kept as signature
  // parameters for call-site compatibility but not used.
  return {
    png: getCreatureImageUrl(_slug),
    svg: getCreatureImageSvgUrl(name || _slug),
  };
}

function MonsterDetail({ monster: initialMonster }: { monster: CompendiumMonster }) {
  const [monster, setMonster] = useState(initialMonster);
  const [versions, setVersions] = useState<{ slug: string; name: string; source: string; cr: string; hp: number; ac: number }[]>([]);
  const [selectedSlug, setSelectedSlug] = useState(initialMonster.slug);
  const imageUrls = getCreatureImage(monster.slug, monster.name, monster.type);
  const [imgSrc, setImgSrc] = useState(imageUrls.png);
  const [imgExists, setImgExists] = useState(true);
  const isDM = useSessionStore((s) => s.isDM);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageSource, setImageSource] = useState(initialMonster.tokenImageSource || 'generated');

  const handleUploadToken = async (file: File) => {
    setUploading(true);
    const formData = new FormData();
    formData.append('image', file);
    try {
      const resp = await fetch(`/api/compendium/monsters/${monster.slug}/token-image`, {
        method: 'POST',
        body: formData,
      });
      if (resp.ok) {
        const data = await resp.json();
        setImgSrc(data.url + '?t=' + Date.now()); // cache-bust
        setImgExists(true);
        setImageSource('uploaded');
      }
    } catch { /* ignore */ }
    setUploading(false);
  };

  // Fetch all versions of this monster
  useEffect(() => {
    fetch(`/api/compendium/monsters/${initialMonster.slug}/versions`)
      .then(r => r.ok ? r.json() : [])
      .then(v => setVersions(v))
      .catch(() => {});
  }, [initialMonster.slug]);

  // Switch version
  const [originalSlug] = useState(initialMonster.slug);
  const isChanged = selectedSlug !== originalSlug;

  const handleVersionChange = (slug: string) => {
    if (slug === selectedSlug) return;
    setSelectedSlug(slug);
    // Preview the version immediately
    fetch(`/api/compendium/monsters/${slug}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) { setMonster(data); setImgExists(true); } })
      .catch(() => {});
  };

  const applyChanges = () => {
    // Update the token's character record with the current version's stats
    const selectedTokenId = useMapStore.getState().selectedTokenId;
    if (selectedTokenId) {
      const token = useMapStore.getState().tokens[selectedTokenId];
      if (token?.characterId) {
        const updates: Record<string, unknown> = {
          hitPoints: monster.hitPoints,
          maxHitPoints: monster.hitPoints,
          armorClass: monster.armorClass,
          speed: typeof monster.speed === 'object' ? (monster.speed.walk || 30) : 30,
          abilityScores: JSON.stringify(monster.abilityScores),
        };
        emitCharacterUpdate(token.characterId, updates);
      }
    }
  };

  return (
    <div style={detailStyles.monsterBlock}>
      {/* Version selector */}
      {versions.length > 1 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: theme.text.muted, fontWeight: 600 }}>Source:</span>
            {versions.map(v => {
              const isActive = v.slug === selectedSlug;
              const isOriginal = v.slug === originalSlug;
              return (
                <button key={v.slug} onClick={() => handleVersionChange(v.slug)} style={{
                  padding: '3px 8px', fontSize: 10, borderRadius: 12, cursor: 'pointer',
                  border: isActive ? `1px solid ${theme.state.danger}` : '1px solid transparent',
                  background: isActive ? theme.state.dangerBg : 'rgba(255,255,255,0.05)',
                  color: isActive ? theme.text.primary : theme.text.muted,
                  fontWeight: isActive ? 600 : 400,
                  fontFamily: 'inherit', transition: 'all 0.15s',
                }}>
                  {v.source}
                  {isOriginal && !isActive && <span style={{ marginLeft: 3, fontSize: 8, color: theme.text.muted }}>●</span>}
                </button>
              );
            })}
          </div>

          {/* Apply bar - shows when previewing a different version */}
          {isChanged && (
            <div style={{
              marginTop: 8, display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', background: 'rgba(197,49,49,0.08)',
              borderRadius: 6, border: '1px solid rgba(197,49,49,0.2)',
            }}>
              <span style={{ flex: 1, fontSize: 11, color: theme.text.secondary }}>
                Viewing <strong style={{ color: theme.text.primary }}>{monster.source}</strong> — HP {monster.hitPoints}, AC {monster.armorClass}
              </span>
              <button onClick={applyChanges} style={{
                padding: '5px 16px', fontSize: 11, fontWeight: 700, borderRadius: 4,
                background: theme.state.danger, border: 'none',
                color: theme.text.primary, cursor: 'pointer', fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}>
                Apply
              </button>
            </div>
          )}
        </div>
      )}

      {/* Single source label */}
      {versions.length <= 1 && (monster.source || (versions.length === 1 && versions[0].source)) && (
        <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 6 }}>
          Source: {versions.length === 1 ? versions[0].source : monster.source}
        </div>
      )}

      {/* Header with image */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {imgExists && (
            <img
              loading="lazy"
              src={imgSrc}
              alt={monster.name}
              onError={() => {
                if (imgSrc === imageUrls.png || imgSrc.includes('?t=')) {
                  setImgSrc(imageUrls.svg);
                } else {
                  setImgExists(false);
                }
              }}
              style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${theme.state.danger}` }}
            />
          )}
          {/* DM upload button */}
          {isDM && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUploadToken(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Upload custom token art"
                style={{
                  position: 'absolute', bottom: -4, right: -4,
                  width: 22, height: 22, borderRadius: '50%',
                  background: theme.bg.deep, border: `2px solid ${theme.border.default}`,
                  color: theme.text.secondary, fontSize: 12, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 0,
                }}
              >
                {uploading ? '...' : '📷'}
              </button>
            </>
          )}
          {/* Image source badge */}
          {imageSource === 'generated' && (
            <div
              title="Placeholder — upload custom art"
              style={{
                position: 'absolute', top: -2, right: -2,
                fontSize: 7, fontWeight: 700, color: theme.text.muted,
                background: theme.bg.elevated, border: `1px solid ${theme.border.light}`,
                borderRadius: 3, padding: '1px 3px', lineHeight: 1,
              }}
            >
              GEN
            </div>
          )}
        </div>
        <div>
          <h2 style={{ ...detailStyles.monsterName, margin: 0 }}>{monster.name}</h2>
          <p style={{ ...detailStyles.monsterSubtitle, margin: '2px 0 0' }}>
            {monster.size} {monster.type}, {monster.alignment}
          </p>
        </div>
      </div>

      <div style={detailStyles.divider} />

      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Armor Class</span> {monster.armorClass}
      </div>
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Hit Points</span> {monster.hitPoints}
        {monster.hitDice && <span style={detailStyles.hitDice}> ({monster.hitDice})</span>}
      </div>
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Speed</span> {formatSpeed(monster.speed)}
      </div>

      <div style={detailStyles.divider} />

      {/* Ability Scores */}
      <div style={detailStyles.abilityRow}>
        {ABILITY_LABELS.map((label, i) => (
          <div key={label} style={detailStyles.abilityBox}>
            <div style={detailStyles.abilityLabel}>{label}</div>
            <div style={detailStyles.abilityScore}>
              {monster.abilityScores[ABILITY_KEYS[i]]}
            </div>
            <div style={detailStyles.abilityMod}>
              ({abilityMod(monster.abilityScores[ABILITY_KEYS[i]])})
            </div>
          </div>
        ))}
      </div>

      <div style={detailStyles.divider} />

      {monster.damageResistances && (
        <div style={detailStyles.statLine}>
          <span style={detailStyles.statLabel}>Damage Resistances</span> {monster.damageResistances}
        </div>
      )}
      {monster.damageImmunities && (
        <div style={detailStyles.statLine}>
          <span style={detailStyles.statLabel}>Damage Immunities</span> {monster.damageImmunities}
        </div>
      )}
      {monster.conditionImmunities && (
        <div style={detailStyles.statLine}>
          <span style={detailStyles.statLabel}>Condition Immunities</span> {monster.conditionImmunities}
        </div>
      )}
      {monster.senses && (
        <div style={detailStyles.statLine}>
          <span style={detailStyles.statLabel}>Senses</span> {monster.senses}
        </div>
      )}
      {monster.languages && (
        <div style={detailStyles.statLine}>
          <span style={detailStyles.statLabel}>Languages</span> {monster.languages}
        </div>
      )}
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Challenge</span> {monster.challengeRating}
      </div>

      {/* Special Abilities */}
      {monster.specialAbilities.length > 0 && (
        <>
          <div style={detailStyles.divider} />
          <h3 style={detailStyles.sectionTitle}>Traits</h3>
          {monster.specialAbilities.map((a, i) => (
            <div key={i} style={detailStyles.traitBlock}>
              <span style={detailStyles.traitName}>{a.name}.</span>{' '}
              <MarkdownContent text={a.desc} />
            </div>
          ))}
        </>
      )}

      {/* Actions */}
      {monster.actions.length > 0 && (
        <>
          <div style={detailStyles.divider} />
          <h3 style={detailStyles.sectionTitle}>Actions</h3>
          {monster.actions.map((a, i) => (
            <div key={i} style={detailStyles.traitBlock}>
              <span style={detailStyles.traitName}>{a.name}.</span>{' '}
              {a.attack_bonus != null && (
                <span style={detailStyles.attackBonus}>+{a.attack_bonus} to hit</span>
              )}
              {a.attack_bonus != null && a.damage_dice && ', '}
              {a.damage_dice && (
                <span style={detailStyles.damageDice}>{a.damage_dice} damage</span>
              )}
              {(a.attack_bonus != null || a.damage_dice) && '. '}
              <MarkdownContent text={a.desc} />
            </div>
          ))}
        </>
      )}

      {/* Legendary Actions */}
      {monster.legendaryActions.length > 0 && (
        <>
          <div style={detailStyles.divider} />
          <h3 style={detailStyles.sectionTitle}>Legendary Actions</h3>
          {monster.legendaryActions.map((a, i) => (
            <div key={i} style={detailStyles.traitBlock}>
              <span style={detailStyles.traitName}>{a.name}.</span>{' '}
              <MarkdownContent text={a.desc} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Try the GCS PNG first; on onError the caller falls back to `alt`
// (the SVG letter-initial generated by get*IconUrl). The old
// implementation skipped straight to the SVG fallback, which is why
// every detail popup showed a gold letter circle instead of the
// actual artwork we ship on GCS.
function getSpellImage(slug: string, name?: string, school?: string): { png: string; alt: string } {
  // Prefer the authoritative DB slug — re-slugifying the display name
  // mismatches for apostrophes ("Black Goat's Blessing" →
  // "black-goat-s-blessing" via slugify vs "black-goats-blessing" in
  // GCS). Name stays as the fallback for the letter-avatar.
  return {
    png: getSpellImageUrl(slug),
    alt: getSpellIconUrl(name || slug, school),
  };
}

function getItemImage(slug: string, name?: string, type?: string): { png: string; alt: string } {
  return {
    png: getItemImageUrl(slug),
    alt: getItemIconUrl(name || slug, type),
  };
}

function SpellDetail({ spell }: { spell: CompendiumSpell }) {
  const levelSchool =
    spell.level === 0
      ? `${spell.school} cantrip`
      : `${ordinal(spell.level)}-level ${spell.school.toLowerCase()}`;
  const spellImg = getSpellImage(spell.slug, spell.name, spell.school);
  const [spellImgSrc, setSpellImgSrc] = useState(spellImg.png);
  const [imgExists, setImgExists] = useState(true);

  // Add-to-character DM control
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const tokens = useMapStore((s) => s.tokens);
  const [showCharPicker, setShowCharPicker] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  // Build the list of characters this user can grant spells to.
  // DM-only — letting players grant themselves compendium spells was
  // trivial to abuse (e.g. a rogue picks up fireball). The DM runs
  // leveling and spell selection for the party; if a player needs a
  // spell the DM uses this button on their behalf.
  const grantTargets = useMemo(() => {
    if (!isDM) return [];
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];
    for (const t of Object.values(tokens)) {
      const cid = (t as any).characterId as string | null;
      if (!cid || seen.has(cid)) continue;
      const ch = allCharacters[cid];
      if (!ch) continue;
      out.push({ id: cid, name: ch.name || (t as any).name || 'Unnamed' });
      seen.add(cid);
    }
    return out;
    // userId retained only to keep the dep stable when we re-enable
    // self-grant under a future session-setting.
  }, [tokens, allCharacters, isDM, userId]);

  async function grantToCharacter(characterId: string) {
    setAdding(characterId);
    try {
      const ch = allCharacters[characterId];
      if (!ch) return;
      const existingSpells = (typeof ch.spells === 'string' ? JSON.parse(ch.spells) : ch.spells) || [];
      // Skip if they already know it
      if (existingSpells.some((s: any) => s.name?.toLowerCase() === spell.name.toLowerCase())) {
        setShowCharPicker(false);
        setAdding(null);
        return;
      }

      // Inline conversion (mirrors compendiumSpellToCharSpell in CharacterSheetFull)
      const cleanDesc = (spell.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
      const newSpell: any = {
        name: spell.name,
        level: spell.level,
        school: spell.school,
        castingTime: spell.castingTime,
        range: spell.range,
        components: spell.components,
        duration: spell.duration,
        description: spell.description,
        higherLevels: spell.higherLevels,
        isConcentration: !!spell.concentration,
        isRitual: !!spell.ritual,
      };
      const dmgMatch = cleanDesc.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(\w+)\s*damage/i);
      if (dmgMatch) {
        newSpell.damage = dmgMatch[1].replace(/\s/g, '');
        const validTypes = ['acid','bludgeoning','cold','fire','force','lightning','necrotic','piercing','poison','psychic','radiant','slashing','thunder'];
        const t = dmgMatch[2].toLowerCase();
        if (validTypes.includes(t)) newSpell.damageType = t;
      }
      const saveMatch = cleanDesc.match(/(strength|dexterity|constitution|wisdom|intelligence|charisma)\s+saving\s+throw/i);
      if (saveMatch) {
        const m: Record<string, string> = { strength:'str', dexterity:'dex', constitution:'con', wisdom:'wis', intelligence:'int', charisma:'cha' };
        newSpell.savingThrow = m[saveMatch[1].toLowerCase()];
      }
      if (/ranged spell attack/i.test(cleanDesc)) newSpell.attackType = 'ranged';
      else if (/melee spell attack/i.test(cleanDesc)) newSpell.attackType = 'melee';
      const aoeMatch = cleanDesc.match(/(\d+)[- ]foot[- ](radius|sphere|cube|cone|line|cylinder|emanation)/i);
      if (aoeMatch) {
        newSpell.aoeSize = parseInt(aoeMatch[1]);
        const shape = aoeMatch[2].toLowerCase();
        if (shape === 'cube') newSpell.aoeType = 'cube';
        else if (shape === 'cone') newSpell.aoeType = 'cone';
        else if (shape === 'line') newSpell.aoeType = 'line';
        else if (shape === 'cylinder') newSpell.aoeType = 'cylinder';
        else newSpell.aoeType = 'sphere';
      }

      const updated = [...existingSpells, newSpell];
      emitCharacterUpdate(characterId, { spells: updated });
    } catch (err) {
      console.error('Failed to grant spell:', err);
    }
    setAdding(null);
    setShowCharPicker(false);
  }

  return (
    <div style={detailStyles.spellBlock}>
      {/* Header with image */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        {imgExists && (
          <img
            loading="lazy"
            src={spellImgSrc}
            alt={spell.name}
            onError={() => {
              if (spellImgSrc === spellImg.png && spellImg.alt !== spellImg.png) {
                setSpellImgSrc(spellImg.alt);
              } else {
                setImgExists(false);
              }
            }}
            style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${theme.gold.primary}`, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <h2 style={{ ...detailStyles.spellName, margin: 0 }}>{spell.name}</h2>
          <p style={{ ...detailStyles.spellSubtitle, margin: '2px 0 0' }}>{levelSchool}</p>
        </div>

        {/* Add to character */}
        {grantTargets.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowCharPicker(v => !v)} style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 700,
              background: theme.gold.bg, color: theme.gold.primary,
              border: `1px solid ${theme.gold.border}`, borderRadius: 4,
              cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'uppercase', letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}>
              + Add to character
            </button>
            {showCharPicker && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: theme.bg.card, border: `1px solid ${theme.gold.border}`,
                borderRadius: 6, padding: 4, zIndex: 100,
                boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                minWidth: 160, maxHeight: 240, overflowY: 'auto',
              }}>
                <div style={{ fontSize: 9, color: theme.text.muted, padding: '4px 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Grant to:
                </div>
                {grantTargets.map(t => (
                  <button key={t.id} onClick={() => grantToCharacter(t.id)} disabled={adding === t.id} style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '6px 10px', fontSize: 11, fontWeight: 600,
                    background: 'transparent', color: theme.text.primary,
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    borderRadius: 3,
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = theme.gold.bg; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {adding === t.id ? '...' : t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={detailStyles.badgeRow}>
        {spell.concentration && <span style={detailStyles.badge}>Concentration</span>}
        {spell.ritual && <span style={detailStyles.badgeGold}>Ritual</span>}
      </div>

      <div style={detailStyles.divider} />

      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Casting Time</span> {spell.castingTime}
      </div>
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Range</span> {spell.range}
      </div>
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Components</span> {spell.components}
      </div>
      <div style={detailStyles.statLine}>
        <span style={detailStyles.statLabel}>Duration</span> {spell.duration}
      </div>

      <div style={detailStyles.divider} />

      <MarkdownContent text={spell.description} />

      {spell.higherLevels && (
        <>
          <h4 style={detailStyles.atHigherLevels}>At Higher Levels.</h4>
          <MarkdownContent text={spell.higherLevels} />
        </>
      )}

      {Array.isArray(spell.classes) && spell.classes.length > 0 && (
        <div style={detailStyles.classesRow}>
          {spell.classes.map((c) => (
            <span key={c} style={detailStyles.classChip}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemDetail({ item, onClose }: { item: CompendiumItem & { rawJson?: Record<string, unknown> }; onClose?: () => void }) {
  const rarityColor = RARITY_COLORS[item.rarity.toLowerCase()] ?? '#888';
  const itemImg = getItemImage(item.slug, item.name, item.type);
  const [itemImgSrc, setItemImgSrc] = useState(itemImg.png);
  const [imgExists, setImgExists] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isHomebrew = item.source === 'Homebrew' || item.source === 'Custom';
  const fileInputRef = useRef<HTMLInputElement>(null);

  // DM-gated grant flow — mirrors the spell grant above. Players
  // should not be able to hand themselves compendium items either;
  // the DM places loot / awards equipment.
  const isDM = useSessionStore((s) => s.isDM);
  const allCharacters = useCharacterStore((s) => s.allCharacters);
  const tokens = useMapStore((s) => s.tokens);
  const [showCharPicker, setShowCharPicker] = useState(false);
  const [granting, setGranting] = useState<string | null>(null);
  const grantTargets = useMemo(() => {
    if (!isDM) return [];
    const seen = new Set<string>();
    const out: { id: string; name: string }[] = [];
    for (const t of Object.values(tokens)) {
      const cid = (t as any).characterId as string | null;
      if (!cid || seen.has(cid)) continue;
      const ch = allCharacters[cid];
      if (!ch) continue;
      out.push({ id: cid, name: ch.name || (t as any).name || 'Unnamed' });
      seen.add(cid);
    }
    return out;
  }, [tokens, allCharacters, isDM]);

  async function grantItemToCharacter(characterId: string) {
    setGranting(characterId);
    try {
      const ch = allCharacters[characterId];
      if (!ch) return;
      const existingInventory = (
        typeof ch.inventory === 'string' ? JSON.parse(ch.inventory as unknown as string) : ch.inventory
      ) || [];
      const nextItem: Record<string, unknown> = {
        name: item.name,
        quantity: 1,
        type: item.type || 'gear',
        rarity: item.rarity || 'common',
        description: item.description || '',
        slug: item.slug,
        imageUrl: item.slug ? `/uploads/items/${item.slug}.png` : null,
        weight: (raw.weight as number) ?? 0,
        cost: (raw.costGp ?? raw.valueGp ?? 0),
      };
      if (raw.damage) nextItem.damage = raw.damage;
      if (raw.damageType) nextItem.damageType = raw.damageType;
      if (Array.isArray(raw.properties) && (raw.properties as string[]).length > 0) nextItem.properties = raw.properties;
      if (raw.range) nextItem.range = raw.range;
      if (raw.ac || raw.acBonus) nextItem.acBonus = raw.ac ?? raw.acBonus;
      if (item.requiresAttunement) nextItem.attunement = true;
      const nextInventory = [...existingInventory, nextItem];
      emitCharacterUpdate(characterId, { inventory: nextInventory });
      useCharacterStore.getState().applyRemoteUpdate(characterId, { inventory: nextInventory });
      setShowCharPicker(false);
    } finally {
      setGranting(null);
    }
  }

  // Parse raw_json for structured stats
  const raw = (item.rawJson && typeof item.rawJson === 'object') ? item.rawJson : {};
  const damage = raw.damage as string || '';
  const damageType = raw.damageType as string || '';
  const properties = raw.properties as string[] || [];
  const range = raw.range as string || '';
  const weight = raw.weight as number || 0;
  const costGp = (raw.costGp ?? raw.valueGp ?? 0) as number;
  const ac = raw.ac as number || raw.acBonus as number || 0;
  const acType = raw.acType as string || '';
  const versatileDamage = raw.versatileDamage as string || '';
  const strRequired = raw.strRequired as number || 0;
  const stealthDisadvantage = raw.stealthDisadvantage as boolean || false;
  const isWeapon = (item.type || '').toLowerCase().includes('weapon');
  const isArmor = (item.type || '').toLowerCase().includes('armor') || (item.type || '').toLowerCase().includes('shield');

  // Edit state (must be after raw values are parsed)
  const [editName, setEditName] = useState(item.name);
  const [editDesc, setEditDesc] = useState(item.description || '');
  const [editType, setEditType] = useState(item.type || 'gear');
  const [editRarity, setEditRarity] = useState(item.rarity || 'common');
  const [editDamage, setEditDamage] = useState(damage || '');
  const [editDamageType, setEditDamageType] = useState(damageType || '');
  const [editWeight, setEditWeight] = useState(String(weight || ''));
  const [editCost, setEditCost] = useState(String(costGp || ''));
  const [editAC, setEditAC] = useState(String(ac || ''));
  const [editProperties, setEditProperties] = useState<string[]>([...properties]);
  const [editRange, setEditRange] = useState(range || '');

  // If no structured damage, try parsing from description
  let parsedDamage = damage;
  let parsedDamageType = damageType;
  if (!parsedDamage && isWeapon && item.description) {
    const m = item.description.match(/(\d+d\d+(?:\s*\+\s*\d+)?)\s+(slashing|piercing|bludgeoning|fire|cold|lightning|thunder|acid|poison|necrotic|radiant|force|psychic)/i);
    if (m) { parsedDamage = m[1].replace(/\s/g, ''); parsedDamageType = m[2].toLowerCase(); }
  }

  return (
    <div style={detailStyles.itemBlock}>
      {/* Header with image */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
        {imgExists && (
          <img
            loading="lazy"
            src={itemImgSrc}
            alt={item.name}
            onError={() => {
              if (itemImgSrc === itemImg.png && itemImg.alt !== itemImg.png) {
                setItemImgSrc(itemImg.alt);
              } else {
                setImgExists(false);
              }
            }}
            style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${rarityColor}`, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1 }}>
          <h2 style={{ ...detailStyles.itemName, color: rarityColor, margin: 0 }}>{item.name}</h2>
          <p style={{ ...detailStyles.itemSubtitle, margin: '2px 0 0' }}>
            {item.type}
            {item.rarity && (
              <span style={{ color: rarityColor, marginLeft: 8 }}>({item.rarity})</span>
            )}
          </p>
        </div>

        {/* DM-only: grant this item to a character on the map. Mirrors
            the spell "Add to character" button so the DM can award
            loot without opening each character sheet. */}
        {grantTargets.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowCharPicker((v) => !v)} style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 700,
              background: theme.gold.bg, color: theme.gold.primary,
              border: `1px solid ${theme.gold.border}`, borderRadius: 4,
              cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'uppercase', letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}>
              + Add to character
            </button>
            {showCharPicker && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4,
                background: theme.bg.card, border: `1px solid ${theme.gold.border}`,
                borderRadius: 6, padding: 4, zIndex: 100,
                boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                minWidth: 160, maxHeight: 240, overflowY: 'auto',
              }}>
                <div style={{
                  fontSize: 9, color: theme.text.muted, padding: '4px 8px',
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  Grant to:
                </div>
                {grantTargets.map((t) => (
                  <button key={t.id} onClick={() => grantItemToCharacter(t.id)} disabled={granting === t.id} style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '6px 10px', fontSize: 11, fontWeight: 600,
                    background: 'transparent', color: theme.text.primary,
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                    borderRadius: 3,
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = theme.gold.bg; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {granting === t.id ? '...' : t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {item.requiresAttunement && (
        <span style={detailStyles.attunementBadge}>Requires Attunement</span>
      )}

      {/* Weapon / Armor Stats */}
      {(isWeapon || isArmor || weight > 0 || costGp > 0) && (
        <>
          <div style={detailStyles.divider} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
            {parsedDamage && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>Damage</div>
                <div style={itemStatStyles.statValue}>{parsedDamage}</div>
                {parsedDamageType && <div style={itemStatStyles.statSub}>{parsedDamageType}</div>}
              </div>
            )}
            {versatileDamage && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>Versatile</div>
                <div style={itemStatStyles.statValue}>{versatileDamage}</div>
              </div>
            )}
            {isArmor && ac > 0 && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>AC</div>
                <div style={itemStatStyles.statValue}>
                  {item.type === 'Shield' ? `+${ac}` : ac}
                </div>
                {acType && acType !== 'flat' && <div style={itemStatStyles.statSub}>{acType === 'dex' ? '+ Dex' : acType === 'dex-max-2' ? '+ Dex (max 2)' : acType}</div>}
              </div>
            )}
            {range && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>Range</div>
                <div style={itemStatStyles.statValue}>{range} ft.</div>
              </div>
            )}
            {weight > 0 && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>Weight</div>
                <div style={itemStatStyles.statValue}>{weight} lb.</div>
              </div>
            )}
            {costGp > 0 && (
              <div style={itemStatStyles.statBox}>
                <div style={itemStatStyles.statLabel}>Cost</div>
                <div style={itemStatStyles.statValue}>{costGp >= 1 ? `${costGp} gp` : `${Math.round(costGp * 10)} sp`}</div>
              </div>
            )}
          </div>
          {properties.length > 0 && (
            <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 6 }}>
              <span style={{ fontWeight: 700, color: theme.text.muted, fontSize: 10 }}>Properties: </span>
              {properties.join(', ')}
            </div>
          )}
          {strRequired > 0 && (
            <div style={{ fontSize: 11, color: theme.text.muted, marginBottom: 4 }}>Requires Strength {strRequired}</div>
          )}
          {stealthDisadvantage && (
            <div style={{ fontSize: 11, color: theme.state.danger, marginBottom: 4 }}>Disadvantage on Stealth</div>
          )}
        </>
      )}

      <div style={detailStyles.divider} />

      <MarkdownContent text={item.description} />

      {/* Homebrew edit/delete */}
      {isHomebrew && !editing && (
        <div style={{ display: 'flex', gap: 6, marginTop: 12, borderTop: `1px solid ${theme.border.default}`, paddingTop: 10 }}>
          <span style={{ fontSize: 9, color: theme.gold.dim, background: theme.gold.bg, padding: '2px 6px', borderRadius: 3, border: `1px solid ${theme.gold.border}`, alignSelf: 'center' }}>
            Homebrew
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setEditing(true)} style={{
            padding: '4px 12px', fontSize: 10, fontWeight: 600, borderRadius: 4,
            background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
            color: theme.text.secondary, cursor: 'pointer', fontFamily: theme.font.body,
          }}>Edit</button>
          <button onClick={() => setConfirmDelete(true)} style={{
            padding: '4px 12px', fontSize: 10, fontWeight: 600, borderRadius: 4,
            background: 'rgba(197,49,49,0.1)', border: '1px solid rgba(197,49,49,0.3)',
            color: theme.state.danger, cursor: 'pointer', fontFamily: theme.font.body,
          }}>Delete</button>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div style={{
          marginTop: 8, padding: 10, borderRadius: 6,
          background: 'rgba(197,49,49,0.1)', border: '1px solid rgba(197,49,49,0.3)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: theme.state.danger, marginBottom: 6 }}>
            Permanently delete "{item.name}"?
          </div>
          <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 8 }}>
            This cannot be undone. The item will be removed from the homebrew compendium.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setConfirmDelete(false)} style={{
              flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
              color: theme.text.secondary, cursor: 'pointer', fontFamily: theme.font.body,
            }}>Cancel</button>
            <button onClick={async () => {
              await fetch(`/api/custom/items/${item.slug}`, { method: 'DELETE' });
              onClose?.();
            }} style={{
              flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: 'rgba(197,49,49,0.2)', border: '1px solid rgba(197,49,49,0.4)',
              color: theme.state.danger, cursor: 'pointer', fontFamily: theme.font.body,
            }}>Delete Forever</button>
          </div>
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: theme.bg.card, border: `1px solid ${theme.border.default}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: theme.gold.dim, marginBottom: 6, textTransform: 'uppercase' }}>Edit Item</div>

          {/* Image upload */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
            <img loading="lazy" src={itemImgSrc} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${theme.border.default}` }}
              onError={e => { (e.currentTarget).src = getItemIconUrl(item.name, item.type); }} />
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('image', file);
                formData.append('itemId', item.slug); // slug = custom item ID
                const resp = await fetch(`/api/custom/items/${item.slug}/image`, { method: 'POST', body: formData });
                if (resp.ok) {
                  const data = await resp.json();
                  setItemImgSrc(data.url + '?t=' + Date.now());
                  setImgExists(true);
                }
                e.target.value = '';
              }} />
            <button onClick={() => fileInputRef.current?.click()} style={{
              padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
              color: theme.text.secondary, fontFamily: theme.font.body,
            }}>Upload Icon</button>
          </div>

          {/* Name */}
          <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Name"
            style={editInputStyle} />

          {/* Type + Rarity */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select value={editType} onChange={e => setEditType(e.target.value)} style={editSelectStyle}>
              {['gear', 'weapon', 'armor', 'shield', 'potion', 'scroll', 'treasure', 'currency'].map(t =>
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              )}
            </select>
            <select value={editRarity} onChange={e => setEditRarity(e.target.value)}
              style={{ ...editSelectStyle, color: RARITY_COLORS[editRarity] || theme.text.primary }}>
              {Object.keys(RARITY_COLORS).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          {/* Weapon stats */}
          {editType.toLowerCase().includes('weapon') && (<>
            <div style={editLabelStyle}>Damage</div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <select value={editDamage} onChange={e => setEditDamage(e.target.value)} style={editSelectStyle}>
                <option value="">— dice —</option>
                {['1', '1d4', '1d6', '1d8', '1d10', '1d12', '2d6', '2d8', '2d10', '2d12'].map(d =>
                  <option key={d} value={d}>{d}</option>
                )}
              </select>
              <select value={editDamageType} onChange={e => setEditDamageType(e.target.value)} style={editSelectStyle}>
                <option value="">— type —</option>
                {['slashing', 'piercing', 'bludgeoning', 'fire', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'force', 'psychic'].map(t =>
                  <option key={t} value={t}>{t}</option>
                )}
              </select>
            </div>
            <div style={editLabelStyle}>Properties</div>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4 }}>
              {([
                ['Finesse', 'Use STR or DEX for attack and damage rolls'],
                ['Light', 'Can dual-wield with another light weapon'],
                ['Heavy', 'Small creatures have disadvantage'],
                ['Two-Handed', 'Requires both hands to wield'],
                ['Versatile', 'Can use one or two hands (more damage two-handed)'],
                ['Thrown', 'Can throw for a ranged attack using STR'],
                ['Reach', '+5 ft melee range (10 ft total)'],
                ['Ammunition', 'Requires ammo, has normal/long range'],
                ['Loading', 'Only one attack per action even with Extra Attack'],
                ['Special', 'Has unique rules — describe below'],
              ] as [string, string][]).map(([p, tip]) => (
                <button key={p} title={tip} onClick={() => setEditProperties(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])}
                  style={{
                    padding: '1px 5px', fontSize: 8, borderRadius: 3, cursor: 'pointer', fontFamily: theme.font.body,
                    background: editProperties.includes(p) ? theme.gold.bg : 'transparent',
                    border: `1px solid ${editProperties.includes(p) ? theme.gold.border : theme.border.default}`,
                    color: editProperties.includes(p) ? theme.gold.primary : theme.text.muted,
                  }}>{p}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Range</div><input value={editRange} onChange={e => setEditRange(e.target.value)} placeholder="20/60" style={editInputStyle} /></div>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Weight</div><input value={editWeight} onChange={e => setEditWeight(e.target.value)} placeholder="0" style={editInputStyle} /></div>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Cost (gp)</div><input value={editCost} onChange={e => setEditCost(e.target.value)} placeholder="0" style={editInputStyle} /></div>
            </div>
          </>)}

          {/* Armor stats */}
          {(editType.toLowerCase().includes('armor') || editType.toLowerCase() === 'shield') && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>AC</div><input value={editAC} onChange={e => setEditAC(e.target.value)} placeholder="14" style={editInputStyle} /></div>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Weight</div><input value={editWeight} onChange={e => setEditWeight(e.target.value)} placeholder="0" style={editInputStyle} /></div>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Cost (gp)</div><input value={editCost} onChange={e => setEditCost(e.target.value)} placeholder="0" style={editInputStyle} /></div>
            </div>
          )}

          {/* Generic weight/cost for other types */}
          {!editType.toLowerCase().includes('weapon') && !editType.toLowerCase().includes('armor') && editType.toLowerCase() !== 'shield' && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Weight</div><input value={editWeight} onChange={e => setEditWeight(e.target.value)} placeholder="0" style={editInputStyle} /></div>
              <div style={{ flex: 1 }}><div style={editLabelStyle}>Cost (gp)</div><input value={editCost} onChange={e => setEditCost(e.target.value)} placeholder="0" style={editInputStyle} /></div>
            </div>
          )}

          {/* Description */}
          <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description (markdown)..." rows={4}
            style={{ ...editInputStyle, resize: 'vertical', minHeight: 60 }} />

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={() => setEditing(false)} style={{
              flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
              color: theme.text.secondary, cursor: 'pointer', fontFamily: theme.font.body,
            }}>Cancel</button>
            <button onClick={async () => {
              await fetch(`/api/custom/items/${item.slug}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  name: editName, type: editType, rarity: editRarity, description: editDesc,
                  damage: editDamage, damageType: editDamageType,
                  properties: editProperties,
                  weight: parseFloat(editWeight) || 0,
                  valueGp: parseFloat(editCost) || 0,
                }),
              });
              onClose?.();
            }} style={{
              flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600, borderRadius: 4,
              background: theme.gold.bg, border: `1px solid ${theme.gold.border}`,
              color: theme.gold.primary, cursor: 'pointer', fontFamily: theme.font.body,
            }}>Save Changes</button>
          </div>
        </div>
      )}
    </div>
  );
}

const editInputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px', fontSize: 11, marginBottom: 4, boxSizing: 'border-box',
  background: theme.bg.deep, border: `1px solid ${theme.border.default}`, borderRadius: 4,
  color: theme.text.primary, outline: 'none', fontFamily: theme.font.body,
};
const editSelectStyle: React.CSSProperties = {
  flex: 1, padding: '4px 6px', fontSize: 11,
  background: theme.bg.deep, border: `1px solid ${theme.border.default}`, borderRadius: 4,
  color: theme.text.primary, outline: 'none',
};
const editLabelStyle: React.CSSProperties = {
  fontSize: 8, fontWeight: 700, color: theme.text.muted,
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2,
};

const itemStatStyles: Record<string, React.CSSProperties> = {
  statBox: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '4px 10px', borderRadius: 6,
    background: theme.bg.elevated, border: `1px solid ${theme.border.default}`,
    minWidth: 50,
  },
  statLabel: {
    fontSize: 8, fontWeight: 700, color: theme.text.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  statValue: {
    fontSize: 15, fontWeight: 700, color: theme.text.primary,
    fontFamily: theme.font.display,
  },
  statSub: {
    fontSize: 9, color: theme.text.muted, marginTop: -1,
  },
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function CompendiumDetailPopup({ result, onClose }: Props) {
  // `data` also holds the lightweight client-only rule/condition
  // payload — not strictly a CompendiumX, but the dispatch below
  // checks shape before casting so the union stays honest.
  const [data, setData] = useState<
    | CompendiumMonster
    | CompendiumSpell
    | CompendiumItem
    | { kind: 'condition' | 'rule'; name: string; description: string; color?: string }
    | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');

    // Client-only categories (conditions + rules glossary + feats)
    // are static lookup tables; no server round-trip. Match by slug
    // against the rules glossary first (rules share the 'conditions'
    // badge color so they come back typed as category='conditions'),
    // then fall back to the CONDITION_MAP for true 5e conditions.
    if (result.category === 'conditions') {
      const rule = RULES_GLOSSARY.find((r) => r.slug === result.slug);
      if (rule) {
        setData({ kind: 'rule', name: rule.name, description: rule.description });
        setLoading(false);
        return;
      }
      const info = CONDITION_MAP.get(result.slug as never);
      if (info) {
        setData({ kind: 'condition', name: info.label, description: info.description, color: info.color });
        setLoading(false);
        return;
      }
      // Spell / class-feature pseudo-conditions (blessed, raging, hasted…)
      const buff = SPELL_BUFFS.find((b) => b.slug === result.slug);
      if (buff) {
        setData({ kind: 'condition', name: buff.name, description: buff.description, color: buff.color });
        setLoading(false);
        return;
      }
      // Backgrounds also come back typed as category='conditions'
      // since we reuse that badge color; check them before erroring.
      const bg = BACKGROUNDS.find((b) => b.slug === result.slug);
      if (bg) {
        const toolsLine = bg.tools ? `**Tool Proficiencies:** ${bg.tools.join(', ')}` : null;
        const langLine = bg.languages ? `**Languages:** ${bg.languages}` : null;
        const header = [
          `**Skill Proficiencies:** ${bg.skills.join(', ')}`,
          toolsLine,
          langLine,
          `**Feature:** ${bg.feature}`,
        ].filter(Boolean).join('  \n');
        setData({ kind: 'rule', name: bg.name, description: `${header}\n\n---\n\n${bg.description}`, color: '#6aa9d1' });
        setLoading(false);
        return;
      }
      setError('Not found');
      setLoading(false);
      return;
    }
    if (result.category === 'feats') {
      const feat = FEATS.find((f) => f.slug === result.slug);
      if (feat) {
        const body = feat.prerequisite
          ? `_Prerequisite: ${feat.prerequisite}_\n\n${feat.description}`
          : feat.description;
        setData({ kind: 'rule', name: feat.name, description: body, color: '#d4a843' });
        setLoading(false);
        return;
      }
      setError('Feat not found');
      setLoading(false);
      return;
    }
    if (result.category === 'classes') {
      const cls = CLASSES.find((c) => c.slug === result.slug);
      if (cls) {
        const header = [
          `**Hit Die:** d${cls.hitDie}`,
          `**Primary Ability:** ${cls.primaryAbility}`,
          `**Saving Throws:** ${cls.savingThrows.join(', ')}`,
          `**Subclasses:** ${cls.subclasses.join(', ')}`,
        ].join('  \n');
        setData({ kind: 'rule', name: cls.name, description: `${header}\n\n---\n\n${cls.description}`, color: '#9b59b6' });
        setLoading(false);
        return;
      }
      setError('Class not found');
      setLoading(false);
      return;
    }
    if (result.category === 'races') {
      const race = RACES.find((r) => r.slug === result.slug);
      if (race) {
        const header = [
          `**Size:** ${race.size}`,
          `**Speed:** ${race.speed} ft`,
          `**Ability Score Increase:** ${race.asi}`,
          `**Subraces:** ${race.subraces.join(', ')}`,
        ].join('  \n');
        setData({ kind: 'rule', name: race.name, description: `${header}\n\n---\n\n${race.description}`, color: '#1abc9c' });
        setLoading(false);
        return;
      }
      setError('Race not found');
      setLoading(false);
      return;
    }

    const categoryPath = result.category;
    // Apply spell name alias as a safety net so direct fetches with DDB
    // slugs ("tashas-hideous-laughter") still resolve to the SRD entry
    // ("hideous-laughter") even if the caller forgot to alias.
    const slug = categoryPath === 'spells' ? resolveSpellSlug(result.slug) : result.slug;

    // Try compendium first, then custom content as fallback
    fetch(`/api/compendium/${categoryPath}/${slug}`)
      .then((r) => {
        if (r.ok) return r.json();
        // Fallback to custom content API
        const customUrl = categoryPath === 'monsters' ? `/api/custom/monsters/${slug}`
          : categoryPath === 'spells' ? `/api/custom/spells/${slug}`
          : `/api/custom/items/${slug}`;
        return fetch(customUrl).then(r2 => {
          if (!r2.ok) throw new Error(`Not found`);
          return r2.json().then(d => {
            // Normalize custom item fields to match compendium format
            if (categoryPath === 'items') {
              return {
                slug: d.id || d.slug || slug,
                name: d.name,
                type: d.type || 'gear',
                rarity: d.rarity || 'common',
                requiresAttunement: d.requires_attunement === 1,
                description: d.description || d.desc || '',
                source: 'Homebrew',
                rawJson: {
                  damage: d.damage || '',
                  damageType: d.damage_type || '',
                  properties: typeof d.properties === 'string' ? JSON.parse(d.properties || '[]') : (d.properties || []),
                  weight: d.weight || 0,
                  costGp: d.value_gp || 0,
                },
              };
            }
            return { ...d, source: 'Homebrew' };
          });
        });
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [result.slug, result.category]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div style={overlayStyles.backdrop} onClick={onClose}>
      <div style={overlayStyles.popup} onClick={(e) => e.stopPropagation()}>
        <button style={overlayStyles.closeBtn} onClick={onClose} title="Close">
          <X size={20} />
        </button>

        <div style={overlayStyles.scrollArea}>
          {loading && <p style={overlayStyles.loadingText}>Loading...</p>}
          {error && <p style={overlayStyles.errorText}>Error: {error}</p>}

          {!loading && !error && data && result.category === 'monsters' && (
            <MonsterDetail monster={data as CompendiumMonster} />
          )}
          {!loading && !error && data && result.category === 'spells' && (
            <SpellDetail spell={data as CompendiumSpell} />
          )}
          {!loading && !error && data && result.category === 'items' && (
            <ItemDetail item={data as CompendiumItem} onClose={onClose} />
          )}
          {!loading && !error && data && result.category === 'conditions' && (
            <RuleOrConditionDetail entry={data as { kind: 'condition' | 'rule'; name: string; description: string; color?: string }} />
          )}
          {!loading && !error && data && result.category === 'feats' && (
            <RuleOrConditionDetail entry={data as { kind: 'condition' | 'rule'; name: string; description: string; color?: string }} />
          )}
          {!loading && !error && data && result.category === 'classes' && (
            <RuleOrConditionDetail entry={data as { kind: 'condition' | 'rule'; name: string; description: string; color?: string }} />
          )}
          {!loading && !error && data && result.category === 'races' && (
            <RuleOrConditionDetail entry={data as { kind: 'condition' | 'rule'; name: string; description: string; color?: string }} />
          )}
        </div>
      </div>
    </div>
  );
}

function RuleOrConditionDetail({
  entry,
}: {
  entry: { kind: 'condition' | 'rule'; name: string; description: string; color?: string };
}) {
  const accent = entry.color ?? theme.gold.primary;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          display: 'inline-block', width: 8, height: 24, borderRadius: 2,
          background: accent,
        }} aria-hidden />
        <h2 style={{
          margin: 0, color: accent, fontFamily: theme.font.display,
          fontSize: 20, letterSpacing: '0.04em',
        }}>
          {entry.name}
        </h2>
        <span style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase',
          color: theme.text.muted,
        }}>
          {entry.kind === 'condition' ? 'Condition' : 'Rule'}
        </span>
      </div>
      <div style={{ height: 1, background: theme.border.default, marginBottom: 10 }} />
      <MarkdownContent text={entry.description} />
    </div>
  );
}

const overlayStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0, 0, 0, 0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  popup: {
    position: 'relative',
    background: theme.bg.card,
    border: `1px solid ${theme.border.default}`,
    borderRadius: theme.radius.lg,
    boxShadow: theme.shadow.lg,
    maxWidth: 560,
    width: '100%',
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    background: 'transparent',
    border: 'none',
    color: theme.text.muted,
    cursor: 'pointer',
    padding: 4,
    borderRadius: theme.radius.sm,
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollArea: {
    overflow: 'auto',
    padding: '24px 24px 20px',
    flex: 1,
    minHeight: 0,
  },
  loadingText: {
    color: theme.text.muted,
    textAlign: 'center',
    padding: 40,
    margin: 0,
  },
  errorText: {
    color: theme.danger,
    textAlign: 'center',
    padding: 40,
    margin: 0,
  },
};

const detailStyles: Record<string, React.CSSProperties> = {
  // Monster
  monsterBlock: {},
  monsterName: {
    margin: 0,
    fontSize: 22,
    fontFamily: theme.font.display,
    color: theme.state.danger,
    fontWeight: 700,
  },
  monsterSubtitle: {
    margin: '2px 0 0',
    fontSize: 13,
    fontStyle: 'italic',
    color: theme.text.secondary,
  },
  divider: {
    height: 1,
    background: `linear-gradient(to right, ${theme.state.danger}, ${theme.border.default}, transparent)`,
    margin: '10px 0',
    border: 'none',
  },
  statLine: {
    fontSize: 13,
    color: theme.text.primary,
    margin: '3px 0',
    lineHeight: 1.5,
  },
  statLabel: {
    fontWeight: 700,
    color: theme.state.danger,
    marginRight: 6,
  },
  hitDice: {
    color: theme.text.muted,
    fontSize: 12,
  },
  abilityRow: {
    display: 'flex',
    gap: 6,
    justifyContent: 'center',
    margin: '4px 0',
  },
  abilityBox: {
    flex: 1,
    textAlign: 'center',
    border: `1px solid ${theme.state.danger}`,
    borderRadius: theme.radius.sm,
    padding: '4px 2px',
    background: 'rgba(197, 49, 49, 0.05)',
  },
  abilityLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: theme.state.danger,
    letterSpacing: '0.5px',
  },
  abilityScore: {
    fontSize: 16,
    fontWeight: 700,
    color: theme.text.primary,
    lineHeight: 1.3,
  },
  abilityMod: {
    fontSize: 11,
    color: theme.text.secondary,
  },
  sectionTitle: {
    margin: '6px 0 8px',
    fontSize: 16,
    fontFamily: theme.font.display,
    color: theme.state.danger,
    borderBottom: '1px solid rgba(197, 49, 49, 0.3)',
    paddingBottom: 4,
  },
  traitBlock: {
    fontSize: 13,
    color: theme.text.primary,
    margin: '6px 0',
    lineHeight: 1.5,
  },
  traitName: {
    fontWeight: 700,
    fontStyle: 'italic',
  },
  traitDesc: {
    color: theme.text.primary,
  },
  attackBonus: {
    color: theme.gold.primary,
    fontWeight: 600,
  },
  damageDice: {
    color: theme.state.danger,
    fontWeight: 600,
    fontFamily: 'monospace',
  },

  // Spell
  spellBlock: {},
  spellName: {
    margin: 0,
    fontSize: 22,
    fontFamily: theme.font.display,
    color: theme.gold.primary,
    fontWeight: 700,
  },
  spellSubtitle: {
    margin: '2px 0 0',
    fontSize: 13,
    fontStyle: 'italic',
    color: theme.text.secondary,
  },
  badgeRow: {
    display: 'flex',
    gap: 6,
    marginTop: 8,
  },
  badge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: 'rgba(197, 49, 49, 0.15)',
    color: theme.danger,
    border: '1px solid rgba(197, 49, 49, 0.3)',
  },
  badgeGold: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: theme.gold.bg,
    color: theme.gold.primary,
    border: `1px solid ${theme.gold.border}`,
  },
  descText: {
    fontSize: 13,
    color: theme.text.primary,
    lineHeight: 1.6,
    margin: '8px 0',
    whiteSpace: 'pre-wrap',
  },
  atHigherLevels: {
    margin: '12px 0 4px',
    fontSize: 14,
    fontWeight: 700,
    fontStyle: 'italic',
    color: theme.text.primary,
  },
  classesRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 14,
    paddingTop: 10,
    borderTop: `1px solid ${theme.border.default}`,
  },
  classChip: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 10,
    background: theme.bg.elevated,
    color: theme.text.secondary,
    border: `1px solid ${theme.border.default}`,
  },

  // Item
  itemBlock: {},
  itemName: {
    margin: 0,
    fontSize: 22,
    fontFamily: theme.font.display,
    fontWeight: 700,
  },
  itemSubtitle: {
    margin: '2px 0 0',
    fontSize: 13,
    color: theme.text.secondary,
  },
  attunementBadge: {
    display: 'inline-block',
    marginTop: 6,
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: 'rgba(155, 89, 182, 0.15)',
    color: theme.purple,
    border: '1px solid rgba(155, 89, 182, 0.3)',
  },
};
