import { useState, useEffect, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  abilityModifier,
  SKILL_ABILITY_MAP,
  type Character,
  type AbilityName,
  type Skills,
  type Spell,
  type InventoryItem,
  type Feature,
  type SpellSlot,
  type CharacterBackground,
  type CharacterCharacteristics,
  type CharacterPersonality,
  type CharacterNotes,
  type CharacterProficiencies,
  type CharacterSenses,
  type CharacterDefenses,
  type CharacterCurrency,
  type AbilityScores,
  type DeathSaves,
} from '@dnd-vtt/shared';
import { emitRoll, emitCharacterUpdate, emitTokenAdd, emitSystemMessage } from '../../socket/emitters';
import { parseSpellMetaFromDesc, enrichSpellFromDescription } from '../../utils/spell-enrich';
import { useMapStore } from '../../stores/useMapStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCharacterStore } from '../../stores/useCharacterStore';

/* ── Strip HTML tags from descriptions ──────────────────── */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── Dice roll with local result + toast + server emit ──── */
function rollLocal(notation: string): { total: number; dice: string } {
  // Parse simple notation like "1d20+3", "2d6+2", "1d4+2"
  const match = notation.match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!match) return { total: 0, dice: notation };
  const count = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const mod = match[3] ? parseInt(match[3]) : 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + mod;
  const diceStr = rolls.length > 1 ? `[${rolls.join('+')}]` : String(rolls[0]);
  return { total, dice: `${diceStr}${mod >= 0 ? '+' + mod : mod}` };
}

function showRestToast(restType: string, changes: string[]) {
  const existing = document.getElementById('rest-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'rest-toast';
  toast.innerHTML = `
    <div style="font-size:16px;font-weight:700;margin-bottom:6px;color:#d4a843">${restType}</div>
    <div style="font-size:12px;line-height:1.6">
      ${changes.map(c => `<div style="padding:2px 0;border-bottom:1px solid #333">\u2714 ${c}</div>`).join('')}
    </div>
  `;
  Object.assign(toast.style, {
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    padding: '20px 28px', background: '#1a1a1a', color: '#eee', borderRadius: '12px',
    border: '2px solid #d4a843', zIndex: '99999', minWidth: '300px', maxWidth: '420px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 15px rgba(212,168,67,0.3)',
    animation: 'fadeIn 0.3s ease',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

let rollToastTimeout: ReturnType<typeof setTimeout> | null = null;
function showRollToast(notation: string, reason: string) {
  // Roll locally for immediate feedback
  const result = rollLocal(notation);

  // Emit to server (server will also roll and broadcast - the chat will show the server roll)
  emitRoll(notation, reason);

  // Show toast with result
  const existing = document.getElementById('roll-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'roll-toast';
  toast.innerHTML = `
    <div style="font-size:11px;opacity:0.8;margin-bottom:2px">${reason}</div>
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:28px;font-weight:800">${result.total}</span>
      <span style="font-size:12px;opacity:0.7">${notation} = ${result.dice} = ${result.total}</span>
    </div>
  `;
  const isNat20 = notation.includes('1d20') && result.total - (parseInt(notation.split(/[+-]/)[1] || '0')) === 20;
  const isNat1 = notation.includes('1d20') && result.total - (parseInt(notation.split(/[+-]/)[1] || '0')) === 1;
  Object.assign(toast.style, {
    position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
    padding: '10px 24px', borderRadius: '8px',
    background: isNat20 ? '#d4a843' : isNat1 ? '#8b0000' : '#c53131',
    color: '#fff', zIndex: '99999',
    boxShadow: isNat20 ? '0 0 20px rgba(212,168,67,0.6)' : '0 4px 16px rgba(0,0,0,0.5)',
    animation: 'fadeIn 0.2s ease', textAlign: 'center',
  });
  document.body.appendChild(toast);
  if (rollToastTimeout) clearTimeout(rollToastTimeout);
  rollToastTimeout = setTimeout(() => toast.remove(), 3000);
}

/* ── Safe JSON parser ────────────────────────────────────── */
function parse<T>(val: unknown, fallback: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return (val as T) ?? fallback;
}

const RARITY_COLORS: Record<string, string> = {
  common: '#9d9d9d', uncommon: '#1eff00', rare: '#0070dd',
  'very rare': '#a335ee', legendary: '#ff8000', artifact: '#e6cc80',
};

/* ── DDB Color Palette ───────────────────────────────────── */
const C = {
  bgDeep: '#1a1a1a',
  bgCard: '#222222',
  bgElevated: '#2a2a2a',
  bgHover: '#333',
  red: '#c53131',
  redDim: '#8b2222',
  redGlow: '0 0 4px rgba(197,49,49,0.5)',
  textPrimary: '#eee',
  textSecondary: '#aaa',
  textMuted: '#888',
  textDim: '#666',
  border: '#444',
  borderDim: '#333',
  green: '#45a049',
  blue: '#4a9fd5',
  purple: '#8b5cf6',
  gold: '#d4a843',
} as const;

/* ── Label Maps ──────────────────────────────────────────── */
const ABILITY_LABELS: Record<AbilityName, string> = {
  str: 'STR', dex: 'DEX', con: 'CON',
  int: 'INT', wis: 'WIS', cha: 'CHA',
};

const ABILITY_KEYS: AbilityName[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SKILL_LABELS: Record<keyof Skills, string> = {
  acrobatics: 'Acrobatics', animalHandling: 'Animal Handling',
  arcana: 'Arcana', athletics: 'Athletics', deception: 'Deception',
  history: 'History', insight: 'Insight', intimidation: 'Intimidation',
  investigation: 'Investigation', medicine: 'Medicine', nature: 'Nature',
  perception: 'Perception', performance: 'Performance',
  persuasion: 'Persuasion', religion: 'Religion',
  sleightOfHand: 'Sleight of Hand', stealth: 'Stealth', survival: 'Survival',
};

const SKILL_KEYS = Object.keys(SKILL_LABELS) as (keyof Skills)[];

const SCHOOL_ABBREV: Record<string, string> = {
  abjuration: 'ABJ', conjuration: 'CON', divination: 'DIV',
  enchantment: 'ENC', evocation: 'EVO', illusion: 'ILL',
  necromancy: 'NEC', transmutation: 'TRS',
};

/* ── Helpers ─────────────────────────────────────────────── */
function fmtMod(mod: number): string {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function ordinal(n: number): string {
  if (n === 0) return 'Cantrip';
  const s = ['', '1st', '2nd', '3rd'];
  return n <= 3 ? s[n] : `${n}th`;
}

function levelPillLabel(n: number): string {
  if (n === 0) return '0';
  const s = ['', '1ST', '2ND', '3RD'];
  return n <= 3 ? s[n] : `${n}TH`;
}

/* ── Tiny Components ─────────────────────────────────────── */
function ProfDot({ filled, double }: { filled: boolean; double?: boolean }) {
  const base: CSSProperties = {
    width: 10, height: 10, borderRadius: '50%',
    border: `2px solid ${filled ? C.red : C.textMuted}`,
    background: filled ? C.red : 'transparent',
    display: 'inline-block', marginRight: 4, flexShrink: 0,
  };
  if (double) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, marginRight: 4 }}>
        <span style={base} />
        <span style={base} />
      </span>
    );
  }
  return <span style={base} />;
}

function Badge({ children, color = C.red, style }: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return (
    <span style={{
      background: color, color: '#fff', fontSize: 10, fontWeight: 700,
      padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
      letterSpacing: '0.5px', ...style,
    }}>
      {children}
    </span>
  );
}

function Pill({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px', fontSize: 11, fontWeight: 700,
        background: active ? C.red : C.bgElevated,
        color: active ? '#fff' : C.textSecondary,
        border: `1px solid ${active ? C.red : C.border}`,
        borderRadius: 4, cursor: 'pointer', textTransform: 'uppercase',
        letterSpacing: '0.5px', transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );
}

function SlotPip({ filled, onClick }: { filled: boolean; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{
        width: 14, height: 14, borderRadius: '50%',
        border: `2px solid ${C.red}`,
        background: filled ? C.red : 'transparent',
        display: 'inline-block', cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    />
  );
}

function SectionHeader({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '1px', color: C.red, padding: '8px 0 4px',
      borderBottom: `1px solid ${C.borderDim}`, marginBottom: 6, ...style,
    }}>
      {children}
    </div>
  );
}

function RollButton({ notation, reason, label, style }: {
  notation: string; reason?: string; label?: string; style?: CSSProperties;
}) {
  return (
    <button
      onClick={() => emitRoll(notation, reason)}
      title={`Roll ${notation}`}
      style={{
        background: C.red, color: '#fff', border: 'none', borderRadius: 3,
        padding: '3px 8px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
        transition: 'background 0.15s', ...style,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#d44')}
      onMouseLeave={e => (e.currentTarget.style.background = C.red)}
    >
      {label ?? notation}
    </button>
  );
}

/* ── Main Tabs ───────────────────────────────────────────── */
type MainTab = 'actions' | 'spells' | 'inventory' | 'features' | 'background' | 'notes';
const MAIN_TABS: { key: MainTab; label: string }[] = [
  { key: 'actions', label: 'ACTIONS' },
  { key: 'spells', label: 'SPELLS' },
  { key: 'inventory', label: 'INVENTORY' },
  { key: 'features', label: 'FEATURES & TRAITS' },
  { key: 'background', label: 'BACKGROUND' },
  { key: 'notes', label: 'NOTES' },
];

/* ═══════════════════════════════════════════════════════════
   COMPONENT: CharacterSheetFull
   ═══════════════════════════════════════════════════════════ */
export function CharacterSheetFull({ character, onClose, initialTab }: { character: Character; onClose: () => void; initialTab?: string }) {
  const [activeTab, setActiveTab] = useState<MainTab>((initialTab as MainTab) || 'actions');

  /* Parse all potentially-stringified fields */
  const abilityScores = parse<AbilityScores>(character.abilityScores, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
  const skills = parse<Skills>(character.skills, {} as Skills);
  const savingThrows = parse<AbilityName[]>(character.savingThrows, []);
  const spellSlots = parse<Record<number, SpellSlot>>(character.spellSlots, {});
  const spells = parse<Spell[]>(character.spells, []);
  const features = parse<Feature[]>(character.features, []);
  // Subscribe to store directly so equip toggles reflect immediately
  const storeChar = useCharacterStore((s) => s.myCharacter?.id === character.id ? s.myCharacter : s.allCharacters[character.id]);
  const inventory = parse<InventoryItem[]>(storeChar?.inventory ?? character.inventory, []);

  // Auto-enrich inventory items on first load (match to compendium)
  useEffect(() => {
    const hasUnmatched = inventory.some((i: any) => !i.slug && i.name);
    if (!hasUnmatched) return;
    fetch(`/api/characters/${character.id}/inventory/enrich`, { method: 'POST' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.updated) {
          useCharacterStore.getState().applyRemoteUpdate(character.id, { inventory: data.inventory });
        }
      })
      .catch(() => {});
  }, [character.id]); // eslint-disable-line
  const background = parse<CharacterBackground>(character.background, { name: '', description: '', feature: '' });
  const characteristics = parse<CharacterCharacteristics>(character.characteristics, { alignment: '', gender: '', eyes: '', hair: '', skin: '', height: '', weight: '', age: '', faith: '', size: '' });
  const personality = parse<CharacterPersonality>(character.personality, { traits: '', ideals: '', bonds: '', flaws: '' });
  const notes = parse<CharacterNotes>(character.notes, { organizations: '', allies: '', enemies: '', backstory: '', other: '' });
  const proficiencies = parse<CharacterProficiencies>(character.proficiencies, { armor: [], weapons: [], tools: [], languages: [] });
  const senses = parse<CharacterSenses>(character.senses, { passivePerception: 10, passiveInvestigation: 10, passiveInsight: 10, darkvision: 0 });
  const defenses = parse<CharacterDefenses>(character.defenses, { resistances: [], immunities: [], vulnerabilities: [] });
  const conditions = parse<string[]>(character.conditions, []);
  const currency = parse<CharacterCurrency>(character.currency, { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
  const deathSaves = parse<DeathSaves>(character.deathSaves, { successes: 0, failures: 0 });

  const profBonus = character.proficiencyBonus ?? 2;

  // Permission flags so child tabs (Spells, Inventory) can hide DM-only controls
  const isDM = useSessionStore((s) => s.isDM);
  const userId = useSessionStore((s) => s.userId);
  const isOwner = character.userId === userId;

  /* Mod helper */
  const getMod = useCallback((ability: AbilityName) => abilityModifier(abilityScores[ability]), [abilityScores]);

  const getSkillMod = useCallback((skill: keyof Skills) => {
    const ability = SKILL_ABILITY_MAP[skill];
    const base = getMod(ability);
    const prof = skills[skill];
    if (prof === 'expertise') return base + profBonus * 2;
    if (prof === 'proficient') return base + profBonus;
    return base;
  }, [getMod, skills, profBonus]);

  /* HP percentage */
  const hpPct = character.maxHitPoints > 0 ? Math.max(0, Math.min(100, (character.hitPoints / character.maxHitPoints) * 100)) : 0;
  const hpColor = hpPct > 50 ? C.green : hpPct > 25 ? C.gold : C.red;

  /* Close on backdrop click */
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  /* Close on Escape */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  return (
    <div
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.75)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: C.textPrimary,
      }}
    >
      {/* Modal container */}
      <div style={{
        width: '95vw', maxWidth: 1100, maxHeight: '90vh',
        background: C.bgDeep, borderRadius: 8,
        border: `1px solid ${C.border}`,
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden', position: 'relative',
      }}>
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: 8, right: 12, zIndex: 10,
            background: 'transparent', border: 'none',
            color: C.textMuted, fontSize: 24, cursor: 'pointer',
            lineHeight: 1, padding: 4,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = C.textPrimary)}
          onMouseLeave={e => (e.currentTarget.style.color = C.textMuted)}
        >
          &times;
        </button>

        {/* Three-column layout */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* ═══ LEFT COLUMN ═══ */}
          <LeftColumn
            abilityScores={abilityScores}
            skills={skills}
            savingThrows={savingThrows}
            profBonus={profBonus}
            senses={senses}
            proficiencies={proficiencies}
            getMod={getMod}
            getSkillMod={getSkillMod}
          />

          {/* ═══ CENTER COLUMN ═══ */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <HeaderBar character={character} />

            {/* Stats row */}
            <StatsRow
              abilityScores={abilityScores}
              profBonus={profBonus}
              speed={character.speed}
              ac={character.armorClass}
              getMod={getMod}
            />

            {/* HP Section */}
            <HPSection
              hp={character.hitPoints}
              maxHp={character.maxHitPoints}
              tempHp={character.tempHitPoints}
              hpPct={hpPct}
              hpColor={hpColor}
              deathSaves={deathSaves}
            />

            {/* Initiative / AC / Defenses / Conditions row */}
            <div style={{ display: 'flex', gap: 8, padding: '0 16px 8px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <StatBox label="Initiative" value={fmtMod(character.initiative ?? getMod('dex'))} onClick={() => showRollToast(`1d20${fmtMod(character.initiative ?? getMod('dex'))}`, 'Initiative')} />
              <StatBox label="AC" value={String(character.armorClass)} />
              {(defenses.resistances.length > 0 || defenses.immunities.length > 0 || defenses.vulnerabilities.length > 0) && (
                <div style={{ fontSize: 11, color: C.textSecondary, padding: '4px 8px', background: C.bgCard, borderRadius: 4, border: `1px solid ${C.borderDim}` }}>
                  {defenses.resistances.length > 0 && <div><span style={{ color: C.blue, fontWeight: 600 }}>Resist:</span> {defenses.resistances.join(', ')}</div>}
                  {defenses.immunities.length > 0 && <div><span style={{ color: C.gold, fontWeight: 600 }}>Immune:</span> {defenses.immunities.join(', ')}</div>}
                  {defenses.vulnerabilities.length > 0 && <div><span style={{ color: C.red, fontWeight: 600 }}>Vuln:</span> {defenses.vulnerabilities.join(', ')}</div>}
                </div>
              )}
              {conditions.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  {conditions.map((c, i) => <Badge key={i} color={C.purple}>{c}</Badge>)}
                </div>
              )}
            </div>

            {/* Tab Bar */}
            <div style={{
              display: 'flex', gap: 0, padding: '0 16px',
              borderBottom: `2px solid ${C.borderDim}`,
              overflowX: 'auto', flexShrink: 0,
            }}>
              {MAIN_TABS.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  style={{
                    padding: '8px 14px', fontSize: 11, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.5px',
                    background: 'transparent', border: 'none',
                    borderBottom: activeTab === t.key ? `2px solid ${C.red}` : '2px solid transparent',
                    color: activeTab === t.key ? C.red : C.textMuted,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    marginBottom: -2, transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => { if (activeTab !== t.key) e.currentTarget.style.color = C.textSecondary; }}
                  onMouseLeave={e => { if (activeTab !== t.key) e.currentTarget.style.color = C.textMuted; }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content (scrollable) */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              {activeTab === 'actions' && (
                <ActionsTab
                  inventory={inventory}
                  spells={spells}
                  features={features}
                  abilityScores={abilityScores}
                  profBonus={profBonus}
                  getMod={getMod}
                  spellAttackBonus={character.spellAttackBonus}
                  spellSaveDC={character.spellSaveDC}
                />
              )}
              {activeTab === 'spells' && (
                <SpellsTab
                  spells={spells}
                  spellSlots={spellSlots}
                  spellcastingAbility={character.spellcastingAbility}
                  spellAttackBonus={character.spellAttackBonus}
                  spellSaveDC={character.spellSaveDC}
                  abilityScores={abilityScores}
                  profBonus={profBonus}
                  characterId={character.id}
                  characterLevel={character.level}
                  isDM={isDM}
                  isOwner={isOwner}
                />
              )}
              {activeTab === 'inventory' && (
                <InventoryTab inventory={inventory} currency={currency} characterId={character.id} />
              )}
              {activeTab === 'features' && (
                <FeaturesTab features={features} />
              )}
              {activeTab === 'background' && (
                <BackgroundTab
                  background={background}
                  characteristics={characteristics}
                  personality={personality}
                />
              )}
              {activeTab === 'notes' && (
                <NotesTab notes={notes} />
              )}
            </div>
          </div>

          {/* ═══ RIGHT COLUMN ═══ (spacer for symmetry at wide widths) */}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   LEFT COLUMN
   ═══════════════════════════════════════════════════════════ */
function LeftColumn({ abilityScores, skills, savingThrows, profBonus, senses, proficiencies, getMod, getSkillMod }: {
  abilityScores: AbilityScores;
  skills: Skills;
  savingThrows: AbilityName[];
  profBonus: number;
  senses: CharacterSenses;
  proficiencies: CharacterProficiencies;
  getMod: (a: AbilityName) => number;
  getSkillMod: (s: keyof Skills) => number;
}) {
  return (
    <div style={{
      width: 240, minWidth: 240, background: C.bgCard,
      borderRight: `1px solid ${C.borderDim}`,
      overflowY: 'auto', padding: '12px 10px', fontSize: 12,
    }}>
      {/* Saving Throws */}
      <SectionHeader>Saving Throws</SectionHeader>
      {ABILITY_KEYS.map(ab => {
        const prof = savingThrows.includes(ab);
        const mod = getMod(ab) + (prof ? profBonus : 0);
        return (
          <div
            key={ab}
            onClick={() => showRollToast(`1d20${fmtMod(mod)}`, `${ABILITY_LABELS[ab]} Save`)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 4px', cursor: 'pointer', borderRadius: 3,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <ProfDot filled={prof} />
            <span style={{ width: 28, fontWeight: 600, color: C.textSecondary, fontSize: 10, textTransform: 'uppercase' }}>
              {ABILITY_LABELS[ab]}
            </span>
            <span style={{ marginLeft: 'auto', fontWeight: 600, color: C.textPrimary }}>
              {fmtMod(mod)}
            </span>
          </div>
        );
      })}

      {/* Skills */}
      <SectionHeader style={{ marginTop: 12 }}>Skills</SectionHeader>
      {SKILL_KEYS.map(sk => {
        const prof = skills[sk] ?? 'none';
        const mod = getSkillMod(sk);
        const ability = SKILL_ABILITY_MAP[sk];
        return (
          <div
            key={sk}
            onClick={() => showRollToast(`1d20${fmtMod(mod)}`, SKILL_LABELS[sk])}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '2px 4px', cursor: 'pointer', borderRadius: 3,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <ProfDot filled={prof !== 'none'} double={prof === 'expertise'} />
            <span style={{ flex: 1, fontSize: 11, color: C.textPrimary }}>{SKILL_LABELS[sk]}</span>
            <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', marginRight: 4 }}>
              {ABILITY_LABELS[ability]}
            </span>
            <span style={{ fontWeight: 600, color: C.textPrimary, minWidth: 22, textAlign: 'right' }}>
              {fmtMod(mod)}
            </span>
          </div>
        );
      })}

      {/* Passive Scores */}
      <SectionHeader style={{ marginTop: 12 }}>Passive Scores</SectionHeader>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        {([
          ['Percep.', senses.passivePerception],
          ['Invest.', senses.passiveInvestigation],
          ['Insight', senses.passiveInsight],
        ] as const).map(([label, val]) => (
          <div key={label} style={{
            background: C.bgElevated, border: `1px solid ${C.borderDim}`,
            borderRadius: 4, padding: '4px 4px', textAlign: 'center', overflow: 'hidden',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.textPrimary }}>{val}</div>
            <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Senses */}
      {senses.darkvision > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Senses</SectionHeader>
          <div style={{ color: C.textSecondary, fontSize: 11, padding: '2px 4px' }}>
            Darkvision {senses.darkvision} ft.
          </div>
        </>
      )}

      {/* Proficiencies */}
      {(['armor', 'weapons', 'tools', 'languages'] as const).map(cat => {
        const items = proficiencies[cat];
        if (!items || items.length === 0) return null;
        return (
          <div key={cat}>
            <SectionHeader style={{ marginTop: 12 }}>{cat}</SectionHeader>
            <div style={{ color: C.textSecondary, fontSize: 11, padding: '2px 4px', lineHeight: 1.5 }}>
              {items.join(', ')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HEADER BAR
   ═══════════════════════════════════════════════════════════ */
function HeaderBar({ character }: { character: Character }) {
  const [showShortRest, setShowShortRest] = useState(false);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 48px 12px 16px', borderBottom: `1px solid ${C.borderDim}`,
      background: C.bgCard, flexShrink: 0,
      position: 'relative',
    }}>
      {/* Portrait */}
      <div style={{
        width: 60, height: 60, borderRadius: '50%',
        border: `3px solid ${C.red}`, overflow: 'hidden',
        background: C.bgElevated, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: C.redGlow,
      }}>
        {character.portraitUrl ? (
          <img src={character.portraitUrl} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 24, color: C.textMuted }}>{character.name?.[0] ?? '?'}</span>
        )}
      </div>

      {/* Name / class / level */}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, lineHeight: 1.2 }}>
          {character.name}
        </div>
        <div style={{ fontSize: 12, color: C.textSecondary }}>
          {character.race} {character.class} {character.level}
        </div>
      </div>

      {/* Short Rest dialog */}
      {showShortRest && (
        <ShortRestDialog character={character} onClose={() => setShowShortRest(false)} />
      )}

      {/* Rest buttons */}
      <button
        onClick={() => setShowShortRest(true)}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: C.bgElevated, color: C.textSecondary,
          border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = C.bgHover; e.currentTarget.style.color = C.textPrimary; }}
        onMouseLeave={e => { e.currentTarget.style.background = C.bgElevated; e.currentTarget.style.color = C.textSecondary; }}
      >
        Short Rest
      </button>
      <button
        onClick={() => {
          const changes: string[] = [];
          const updates: Record<string, unknown> = {};

          // 1) Restore HP to max
          if (character.hitPoints < character.maxHitPoints) {
            updates.hitPoints = character.maxHitPoints;
            changes.push(`HP restored (${character.hitPoints} \u2192 ${character.maxHitPoints})`);
          }
          // 2) Clear temp HP
          if (character.tempHitPoints > 0) {
            updates.tempHitPoints = 0;
            changes.push('Temporary HP cleared');
          }
          // 3) Restore all spell slots
          const slots = parse<Record<string, { max: number; used: number }>>(character.spellSlots, {});
          const updatedSlots: Record<string, { max: number; used: number }> = {};
          const restoredLevels: string[] = [];
          for (const [lvl, slot] of Object.entries(slots)) {
            if (slot.used > 0) restoredLevels.push(lvl);
            updatedSlots[lvl] = { max: slot.max, used: 0 };
          }
          if (restoredLevels.length > 0) {
            updates.spellSlots = updatedSlots;
            changes.push(`Spell slots restored (level${restoredLevels.length !== 1 ? 's' : ''} ${restoredLevels.join(', ')})`);
          }
          // 4) Restore all feature uses
          const features = parse<Array<{ name: string; usesTotal?: number; usesRemaining?: number; resetOn?: string | null }>>(character.features, []);
          let restoredFeatures = 0;
          const updatedFeatures = features.map((f) => {
            if (f.usesTotal && (f.usesRemaining ?? f.usesTotal) < f.usesTotal) {
              restoredFeatures++;
              return { ...f, usesRemaining: f.usesTotal };
            }
            return f;
          });
          if (restoredFeatures > 0) {
            updates.features = updatedFeatures;
            changes.push(`${restoredFeatures} feature${restoredFeatures !== 1 ? 's' : ''} restored`);
          }
          // 5) Restore half (rounded up) of spent Hit Dice (D&D 5e rule)
          const hitDicePools = parse<Array<{ dieSize: number; total: number; used: number }>>(character.hitDice as unknown, []);
          if (hitDicePools.length > 0) {
            let restoredHd = 0;
            const updatedPools = hitDicePools.map(p => {
              if (p.used <= 0) return p;
              const recovery = Math.max(1, Math.ceil(p.total / 2));
              const newUsed = Math.max(0, p.used - recovery);
              restoredHd += (p.used - newUsed);
              return { ...p, used: newUsed };
            });
            if (restoredHd > 0) {
              updates.hitDice = updatedPools;
              changes.push(`Recovered ${restoredHd} Hit Dice`);
            }
          }
          // 6) Death saves cleared
          updates.deathSaves = { successes: 0, failures: 0 };
          // 7) Drop concentration
          if (character.concentratingOn) {
            updates.concentratingOn = null;
            changes.push(`Concentration on ${character.concentratingOn} dropped`);
          }

          if (changes.length === 0) changes.push('Already fully rested');
          emitCharacterUpdate(character.id, updates);
          useCharacterStore.getState().applyRemoteUpdate(character.id, updates);
          showRestToast('Long Rest', changes);
          emitSystemMessage(`💤 ${character.name} takes a Long Rest\n   ${changes.join(' • ')}`);
        }}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: C.bgElevated, color: C.textSecondary,
          border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = C.bgHover; e.currentTarget.style.color = C.textPrimary; }}
        onMouseLeave={e => { e.currentTarget.style.background = C.bgElevated; e.currentTarget.style.color = C.textSecondary; }}
      >
        Long Rest
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHORT REST DIALOG (Hit Dice spending)
   ═══════════════════════════════════════════════════════════ */
function ShortRestDialog({ character, onClose }: { character: Character; onClose: () => void }) {
  // Pull live hit dice / hp from the store so the dialog updates in real time
  // as the user spends dice.
  const liveChar = useCharacterStore(s => s.allCharacters[character.id] ?? character);
  const hitDicePools = parse<Array<{ dieSize: number; total: number; used: number }>>(liveChar.hitDice as unknown, []);
  const hp = liveChar.hitPoints;
  const maxHp = liveChar.maxHitPoints;
  const conMod = abilityModifier(parse<Record<string, number>>(liveChar.abilityScores, {}).con ?? 10);

  function spendDie(dieSize: number) {
    const poolIdx = hitDicePools.findIndex(p => p.dieSize === dieSize);
    if (poolIdx < 0) return;
    const pool = hitDicePools[poolIdx];
    if (pool.used >= pool.total) return;
    if (hp >= maxHp) return;

    // Roll 1d(dieSize) + CON mod, heal that much (min 1)
    const roll = Math.floor(Math.random() * dieSize) + 1;
    const heal = Math.max(1, roll + conMod);
    const newHp = Math.min(maxHp, hp + heal);

    const updatedPools = hitDicePools.map((p, i) => i === poolIdx ? { ...p, used: p.used + 1 } : p);
    const updates = { hitPoints: newHp, hitDice: updatedPools };
    emitCharacterUpdate(character.id, updates);
    useCharacterStore.getState().applyRemoteUpdate(character.id, updates);

    emitSystemMessage(
      `💤 ${character.name} spends 1d${dieSize} Hit Die\n   Rolled ${roll}${conMod >= 0 ? '+' : ''}${conMod} = ${heal} HP (HP ${hp}→${newHp})`
    );
  }

  function finishRest() {
    // Reset short-rest features + Warlock slots; HP healing is already done
    // via Hit Dice spending above.
    const changes: string[] = [];
    const updates: Record<string, unknown> = {};
    const features = parse<Array<{ name: string; usesTotal?: number; usesRemaining?: number; resetOn?: string | null }>>(liveChar.features, []);
    let restoredFeatures = 0;
    const updatedFeatures = features.map((f) => {
      if (f.resetOn === 'short' && f.usesTotal && (f.usesRemaining ?? f.usesTotal) < f.usesTotal) {
        restoredFeatures++;
        return { ...f, usesRemaining: f.usesTotal };
      }
      return f;
    });
    if (restoredFeatures > 0) {
      updates.features = updatedFeatures;
      changes.push(`${restoredFeatures} short-rest feature${restoredFeatures !== 1 ? 's' : ''} restored`);
    }

    const isWarlock = (liveChar.class || '').toLowerCase().includes('warlock');
    if (isWarlock) {
      const slots = parse<Record<string, { max: number; used: number }>>(liveChar.spellSlots, {});
      const updatedSlots: Record<string, { max: number; used: number }> = {};
      let restoredSlots = 0;
      for (const [lvl, slot] of Object.entries(slots)) {
        if (slot.used > 0) restoredSlots++;
        updatedSlots[lvl] = { max: slot.max, used: 0 };
      }
      if (restoredSlots > 0) {
        updates.spellSlots = updatedSlots;
        changes.push('Warlock spell slots restored');
      }
    }

    if (Object.keys(updates).length > 0) {
      emitCharacterUpdate(character.id, updates);
      useCharacterStore.getState().applyRemoteUpdate(character.id, updates);
    }

    const summary = changes.length > 0
      ? `💤 ${character.name} finishes a Short Rest\n   ${changes.join(' • ')}`
      : `💤 ${character.name} finishes a Short Rest`;
    emitSystemMessage(summary);
    onClose();
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.bgCard, border: `2px solid ${C.red}`, borderRadius: 8,
        padding: 20, minWidth: 360, maxWidth: 480, boxShadow: C.redGlow,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.red, marginBottom: 4, textAlign: 'center', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          Short Rest
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', marginBottom: 14 }}>
          Spend Hit Dice to heal. Each die heals 1d(size) {conMod >= 0 ? '+' : ''}{conMod} HP.
        </div>

        {/* HP gauge */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.textSecondary, marginBottom: 4 }}>
            <span>Hit Points</span>
            <span><b style={{ color: C.textPrimary }}>{hp}</b> / {maxHp}</span>
          </div>
          <div style={{ height: 8, background: C.bgElevated, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${maxHp > 0 ? (hp / maxHp) * 100 : 0}%`, height: '100%', background: hp / maxHp < 0.3 ? C.red : C.gold, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Hit Dice pools */}
        {hitDicePools.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: C.textMuted, fontSize: 12, fontStyle: 'italic' }}>
            No Hit Dice tracked for this character.
            <div style={{ marginTop: 6, fontSize: 11 }}>
              Re-import from D&D Beyond to populate them.
            </div>
          </div>
        )}
        {hitDicePools.map((pool) => {
          const left = pool.total - pool.used;
          const noHeal = hp >= maxHp;
          const noDice = left <= 0;
          const disabled = noHeal || noDice;
          return (
            <div key={pool.dieSize} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px', marginBottom: 6,
              background: C.bgElevated, borderRadius: 6,
              border: `1px solid ${C.borderDim}`,
              opacity: disabled ? 0.5 : 1,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>1d{pool.dieSize}</div>
                <div style={{ fontSize: 10, color: C.textMuted }}>{left} / {pool.total} remaining</div>
              </div>
              <button
                disabled={disabled}
                onClick={() => spendDie(pool.dieSize)}
                title={noHeal ? 'Already at max HP' : noDice ? 'No Hit Dice remaining' : `Roll 1d${pool.dieSize} + ${conMod} CON`}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 700,
                  background: disabled ? C.bgCard : C.red,
                  color: disabled ? C.textMuted : '#fff',
                  border: `1px solid ${disabled ? C.borderDim : C.red}`,
                  borderRadius: 4,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Spend
              </button>
            </div>
          );
        })}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '8px 12px', fontSize: 12, fontWeight: 600,
            background: 'transparent', color: C.textSecondary,
            border: `1px solid ${C.border}`, borderRadius: 4, cursor: 'pointer',
            fontFamily: 'inherit',
          }}>
            Cancel
          </button>
          <button onClick={finishRest} style={{
            flex: 2, padding: '8px 12px', fontSize: 12, fontWeight: 700,
            background: C.gold, color: '#1a1a1a',
            border: `1px solid ${C.gold}`, borderRadius: 4, cursor: 'pointer',
            fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>
            Finish Short Rest
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STATS ROW
   ═══════════════════════════════════════════════════════════ */
function StatsRow({ abilityScores, profBonus, speed, ac, getMod }: {
  abilityScores: AbilityScores; profBonus: number; speed: number; ac: number;
  getMod: (a: AbilityName) => number;
}) {
  return (
    <div style={{
      display: 'flex', gap: 6, padding: '10px 16px',
      overflowX: 'auto', flexShrink: 0, flexWrap: 'wrap',
    }}>
      {ABILITY_KEYS.map(ab => (
        <div
          key={ab}
          onClick={() => showRollToast(`1d20${fmtMod(getMod(ab))}`, `${ABILITY_LABELS[ab]} Check`)}
          style={{
            width: 56, textAlign: 'center', padding: '6px 0',
            border: `2px solid ${C.red}`, borderRadius: 6,
            background: C.bgCard, cursor: 'pointer',
            transition: 'box-shadow 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.boxShadow = C.redGlow)}
          onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
        >
          <div style={{ fontSize: 9, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {ABILITY_LABELS[ab]}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>
            {fmtMod(getMod(ab))}
          </div>
          <div style={{ fontSize: 10, color: C.textMuted }}>{abilityScores[ab]}</div>
        </div>
      ))}

      {/* Prof / Speed / AC */}
      <StatBox label="Prof" value={fmtMod(profBonus)} />
      <StatBox label="Speed" value={`${speed}`} />
    </div>
  );
}

function StatBox({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 56, textAlign: 'center', padding: '6px 0',
        border: `1px solid ${C.border}`, borderRadius: 6,
        background: C.bgCard, cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>
        {value}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   HP SECTION
   ═══════════════════════════════════════════════════════════ */
function HPSection({ hp, maxHp, tempHp, hpPct, hpColor, deathSaves }: {
  hp: number; maxHp: number; tempHp: number; hpPct: number; hpColor: string;
  deathSaves: DeathSaves;
}) {
  return (
    <div style={{ padding: '4px 16px 8px' }}>
      {/* HP bar */}
      <div style={{
        height: 18, background: C.bgElevated, borderRadius: 9,
        overflow: 'hidden', border: `1px solid ${C.borderDim}`,
        position: 'relative',
      }}>
        <div style={{
          width: `${hpPct}%`, height: '100%',
          background: hpColor, borderRadius: 9,
          transition: 'width 0.3s, background 0.3s',
        }} />
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)',
        }}>
          {hp} / {maxHp}
          {tempHp > 0 && <span style={{ color: C.blue, marginLeft: 4 }}>+{tempHp} temp</span>}
        </div>
      </div>

      {/* Death saves (if at 0 HP) */}
      {hp <= 0 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 11 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: C.green, fontWeight: 600 }}>Saves:</span>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 10, height: 10, borderRadius: '50%',
                border: `2px solid ${C.green}`,
                background: i < deathSaves.successes ? C.green : 'transparent',
                display: 'inline-block',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: C.red, fontWeight: 600 }}>Fails:</span>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 10, height: 10, borderRadius: '50%',
                border: `2px solid ${C.red}`,
                background: i < deathSaves.failures ? C.red : 'transparent',
                display: 'inline-block',
              }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: ACTIONS
   ═══════════════════════════════════════════════════════════ */
type ActionFilter = 'all' | 'attack' | 'action' | 'bonus' | 'reaction' | 'other' | 'limited';
const ACTION_FILTERS: { key: ActionFilter; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'attack', label: 'ATTACK' },
  { key: 'action', label: 'ACTION' },
  { key: 'bonus', label: 'BONUS ACTION' },
  { key: 'reaction', label: 'REACTION' },
  { key: 'other', label: 'OTHER' },
  { key: 'limited', label: 'LIMITED USE' },
];

function ActionsTab({ inventory, spells, features, abilityScores, profBonus, getMod, spellAttackBonus, spellSaveDC }: {
  inventory: InventoryItem[];
  spells: Spell[];
  features: Feature[];
  abilityScores: AbilityScores;
  profBonus: number;
  getMod: (a: AbilityName) => number;
  spellAttackBonus: number;
  spellSaveDC: number;
}) {
  const [filter, setFilter] = useState<ActionFilter>('all');

  /* Equipped weapons */
  const weapons = inventory.filter(i => i.type === 'weapon' && i.equipped);
  /* Damaging cantrips */
  const attackCantrips = spells.filter(s => s.level === 0 && (s.damage || s.attackType));
  /* Features with limited uses */
  const limitedFeatures = features.filter(f => (f.usesTotal ?? 0) > 0);
  /* Class abilities (features that aren't limited-use) */
  const classAbilities = features.filter(f => !f.usesTotal);

  const showWeapons = filter === 'all' || filter === 'attack';
  const showCantrips = filter === 'all' || filter === 'attack';
  const showLimited = filter === 'all' || filter === 'limited';
  const showAbilities = filter === 'all' || filter === 'action' || filter === 'bonus' || filter === 'other';

  return (
    <div>
      {/* Sub-filters */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {ACTION_FILTERS.map(f => (
          <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Pill>
        ))}
      </div>

      {/* Weapons */}
      {showWeapons && weapons.length > 0 && (
        <>
          <SectionHeader>Weapons</SectionHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {weapons.map((w, i) => {
              /* Guess attack mod: finesse weapons use higher of str/dex, ranged use dex */
              const isFinesse = w.properties?.some(p => p.toLowerCase().includes('finesse'));
              const isRanged = w.properties?.some(p => p.toLowerCase().includes('ranged')) || w.properties?.some(p => p.toLowerCase().includes('ammunition'));
              let atkAbility: AbilityName = 'str';
              if (isRanged) atkAbility = 'dex';
              else if (isFinesse && getMod('dex') > getMod('str')) atkAbility = 'dex';
              const atkMod = getMod(atkAbility) + profBonus;
              const dmgMod = getMod(atkAbility);
              const dmgStr = w.damage ?? '1d6';
              const range = w.properties?.find(p => p.toLowerCase().includes('range'))?.replace(/range/i, '').trim() || (isRanged ? '80/320' : '5 ft.');

              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', background: C.bgCard,
                  borderRadius: 4, border: `1px solid ${C.borderDim}`,
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{w.name}</div>
                    {w.properties && w.properties.length > 0 && (
                      <div style={{ fontSize: 10, color: C.textMuted }}>{w.properties.join(', ')}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, minWidth: 60, textAlign: 'center' }}>{range}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, minWidth: 36, textAlign: 'center' }}>{fmtMod(atkMod)}</div>
                  <div style={{ fontSize: 12, color: C.textSecondary, minWidth: 60, textAlign: 'center' }}>
                    {dmgStr}{dmgMod !== 0 ? fmtMod(dmgMod) : ''} {w.damageType ?? ''}
                  </div>
                  <RollButton notation={`1d20${fmtMod(atkMod)}`} reason={`${w.name} Attack`} label="ATK" />
                  <RollButton
                    notation={`${dmgStr}${dmgMod !== 0 ? fmtMod(dmgMod) : ''}`}
                    reason={`${w.name} Damage`}
                    label="DMG"
                    style={{ background: C.redDim }}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Attack Cantrips */}
      {showCantrips && attackCantrips.length > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Spell Attacks</SectionHeader>
          {attackCantrips.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', background: C.bgCard,
              borderRadius: 4, border: `1px solid ${C.borderDim}`, marginBottom: 2,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                <div style={{ fontSize: 10, color: C.textMuted }}>{s.school} cantrip</div>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, minWidth: 50, textAlign: 'center' }}>{s.range}</div>
              {s.attackType && (
                <div style={{ fontSize: 13, fontWeight: 600, minWidth: 36, textAlign: 'center' }}>
                  {fmtMod(spellAttackBonus)}
                </div>
              )}
              {s.savingThrow && (
                <div style={{ fontSize: 11, color: C.gold, minWidth: 50, textAlign: 'center' }}>
                  DC {spellSaveDC} {ABILITY_LABELS[s.savingThrow]}
                </div>
              )}
              <div style={{ fontSize: 12, color: C.textSecondary, minWidth: 60, textAlign: 'center' }}>
                {s.damage ?? ''} {s.damageType ?? ''}
              </div>
              {s.attackType && (
                <RollButton notation={`1d20${fmtMod(spellAttackBonus)}`} reason={`${s.name} Attack`} label="ATK" />
              )}
              {s.damage && (
                <RollButton notation={s.damage} reason={`${s.name} Damage`} label="DMG" style={{ background: C.redDim }} />
              )}
            </div>
          ))}
        </>
      )}

      {/* Limited Use Features */}
      {showLimited && limitedFeatures.length > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Limited Use</SectionHeader>
          {limitedFeatures.map((f, i) => {
            const usesLeft = f.usesRemaining ?? f.usesTotal ?? 0;
            const isSpent = (f.usesTotal ?? 0) > 0 && usesLeft <= 0;
            const rechargeLabel = f.resetOn === 'short' ? 'Short Rest' : f.resetOn === 'long' ? 'Long Rest' : f.resetOn === 'dawn' ? 'Dawn' : 'Long Rest';
            const tooltip = isSpent
              ? `${f.name} — All uses spent (0/${f.usesTotal}). Recharges on ${rechargeLabel}.`
              : `${f.name} — ${usesLeft}/${f.usesTotal} uses remaining. Recharges on ${rechargeLabel}.`;
            return (
              <div key={i} title={tooltip} style={{
                padding: '6px 8px', background: C.bgCard,
                borderRadius: 4, border: `1px solid ${C.borderDim}`, marginBottom: 2,
                opacity: isSpent ? 0.5 : 1,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, textDecoration: isSpent ? 'line-through' : 'none', color: isSpent ? C.textMuted : C.textPrimary }}>
                      {f.name}
                    </span>
                    <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 6 }}>{f.source}</span>
                    {isSpent && <span style={{ color: C.red, marginLeft: 6, fontSize: 9, fontWeight: 700 }}>SPENT</span>}
                  </div>
                  <span style={{ fontSize: 10, color: isSpent ? C.red : C.textSecondary, fontWeight: 600 }}>
                    {usesLeft}/{f.usesTotal}
                  </span>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    {Array.from({ length: f.usesTotal! }).map((_, j) => (
                      <span key={j} style={{
                        width: 12, height: 12, borderRadius: '50%',
                        border: `2px solid ${C.red}`,
                        background: j < usesLeft ? C.red : 'transparent',
                        display: 'inline-block',
                      }} />
                    ))}
                  </div>
                  {f.resetOn && (
                    <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase' }}>
                      {f.resetOn === 'short' ? 'Short Rest' : f.resetOn === 'long' ? 'Long Rest' : f.resetOn}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4, lineHeight: 1.4 }}>
                  {stripHtml(f.description)}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Class Abilities */}
      {showAbilities && classAbilities.length > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Class Abilities</SectionHeader>
          {classAbilities.map((f, i) => (
            <div key={i} style={{
              padding: '6px 8px', background: C.bgCard,
              borderRadius: 4, border: `1px solid ${C.borderDim}`, marginBottom: 2,
            }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{f.name}
                <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 6 }}>{f.source}</span>
              </div>
              <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2, lineHeight: 1.4 }}>
                {stripHtml(f.description)}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Empty state */}
      {weapons.length === 0 && attackCantrips.length === 0 && limitedFeatures.length === 0 && classAbilities.length === 0 && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: 40, fontSize: 13 }}>
          No actions available. Equip weapons or add spells and features.
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: SPELLS
   ═══════════════════════════════════════════════════════════ */
const SCHOOL_COLORS: Record<string, string> = {
  Evocation: '#c53131', Necromancy: '#2e7d32', Abjuration: '#2980b9',
  Enchantment: '#9b59b6', Conjuration: '#1abc9c', Transmutation: '#d4a843',
  Divination: '#a0a0c0', Illusion: '#e67e22',
  evocation: '#c53131', necromancy: '#2e7d32', abjuration: '#2980b9',
  enchantment: '#9b59b6', conjuration: '#1abc9c', transmutation: '#d4a843',
  divination: '#a0a0c0', illusion: '#e67e22',
};

/**
 * Convert a CompendiumSpell into a character Spell object, parsing the
 * description for damage dice, damage type, save ability, AoE shape/size,
 * and attack type. Used by the "Add Spell" dialog and any DM tooling that
 * needs to grant spells to a character.
 */
function compendiumSpellToCharSpell(comp: any): Spell {
  const parsed = parseSpellMetaFromDesc(comp.description || '');
  return {
    name: comp.name,
    level: comp.level ?? 0,
    school: comp.school ?? '',
    castingTime: comp.castingTime ?? '1 action',
    range: comp.range ?? '',
    components: comp.components ?? '',
    duration: comp.duration ?? 'Instantaneous',
    description: comp.description ?? '',
    higherLevels: comp.higherLevels ?? '',
    isConcentration: !!comp.concentration,
    isRitual: !!comp.ritual,
    damage: parsed.damage,
    damageType: parsed.damageType,
    savingThrow: parsed.savingThrow,
    aoeType: parsed.aoeType,
    aoeSize: parsed.aoeSize,
    attackType: parsed.attackType,
  };
}

/**
 * Modal dialog for the DM (or character owner) to search the compendium and
 * add a spell to a character. Calls onAdd(spell) for each click and closes
 * via onClose. Filtering is server-side via /api/compendium/search and
 * /api/compendium/spells.
 */
function AddSpellDialog({ existingSpellNames, onAdd, onClose }: {
  existingSpellNames: Set<string>;
  onAdd: (spell: Spell) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<number | null>(null);
  const [results, setResults] = useState<Array<{ slug: string; name: string; level: number; school: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  // Fetch on filter change (with a debounce on search text)
  useEffect(() => {
    let cancelled = false;
    const fetchResults = async () => {
      setLoading(true);
      try {
        let data: any[];
        if (search.trim().length >= 2) {
          // Full-text search via the /search endpoint
          const r = await fetch(`/api/compendium/search?q=${encodeURIComponent(search.trim())}&category=spells&limit=40`);
          const j = await r.json();
          data = (j.results || []).map((row: any) => ({
            slug: row.slug,
            name: row.name,
            level: row.level ?? 0,
            school: row.snippet?.split(' ')[0] || '',
          }));
        } else {
          // Browse mode: list spells (filtered by level if set)
          const params = new URLSearchParams();
          params.set('limit', '60');
          if (levelFilter !== null) params.set('level', String(levelFilter));
          const r = await fetch(`/api/compendium/spells?${params.toString()}`);
          data = await r.json();
        }
        if (!cancelled) setResults(data);
      } catch (err) {
        if (!cancelled) setResults([]);
      }
      if (!cancelled) setLoading(false);
    };
    const timeout = setTimeout(fetchResults, search.trim().length >= 2 ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [search, levelFilter]);

  async function handleAdd(slug: string) {
    setAdding(slug);
    try {
      const r = await fetch(`/api/compendium/spells/${slug}`);
      if (r.ok) {
        const comp = await r.json();
        const spell = compendiumSpellToCharSpell(comp);
        onAdd(spell);
      }
    } catch { /* ignore */ }
    setAdding(null);
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.bgCard, border: `2px solid ${C.gold}`, borderRadius: 8,
        padding: 16, width: 540, maxWidth: '90vw', maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.gold, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Add Spell
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: C.textMuted,
            fontSize: 20, cursor: 'pointer', padding: '0 6px',
          }}>×</button>
        </div>

        {/* Search */}
        <input
          autoFocus
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search 1400+ spells (e.g. fireball)..."
          style={{
            width: '100%', padding: '8px 12px', marginBottom: 8,
            background: C.bgElevated, border: `1px solid ${C.border}`,
            borderRadius: 6, color: C.textPrimary, fontSize: 13,
            outline: 'none', boxSizing: 'border-box',
          }}
        />

        {/* Level filter pills (only when not searching) */}
        {search.trim().length < 2 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
            <Pill active={levelFilter === null} onClick={() => setLevelFilter(null)}>ALL</Pill>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(l => (
              <Pill key={l} active={levelFilter === l} onClick={() => setLevelFilter(l)}>
                {l === 0 ? 'CANTRIP' : `L${l}`}
              </Pill>
            ))}
          </div>
        )}

        {/* Results list */}
        <div style={{
          flex: 1, overflowY: 'auto', minHeight: 0,
          border: `1px solid ${C.borderDim}`, borderRadius: 6,
          background: C.bgElevated,
        }}>
          {loading && results.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: C.textMuted, fontSize: 12 }}>Loading...</div>
          )}
          {!loading && results.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: C.textMuted, fontSize: 12 }}>
              {search.trim().length >= 2 ? `No spells found for "${search}"` : 'No spells'}
            </div>
          )}
          {results.map(r => {
            const slug = r.slug;
            const alreadyKnown = existingSpellNames.has(r.name.toLowerCase());
            const isAdding = adding === slug;
            const schoolColor = SCHOOL_COLORS[r.school] || C.textMuted;
            return (
              <div key={slug} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px',
                borderBottom: `1px solid ${C.borderDim}`,
                background: alreadyKnown ? 'rgba(212,168,67,0.06)' : 'transparent',
              }}>
                <img src={`/uploads/spells/${slug}.png`} alt="" loading="lazy"
                  style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: `1.5px solid ${schoolColor}`, flexShrink: 0 }}
                  onError={e => { (e.currentTarget).src = '/uploads/items/default-item.svg'; }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: alreadyKnown ? C.textMuted : C.textPrimary }}>
                    {r.name}
                    {alreadyKnown && <span style={{ marginLeft: 6, fontSize: 9, color: C.gold, fontWeight: 700 }}>KNOWN</span>}
                  </div>
                  <div style={{ fontSize: 10, color: C.textMuted }}>
                    {r.level === 0 ? 'Cantrip' : `Level ${r.level}`}{r.school ? ` · ${r.school}` : ''}
                  </div>
                </div>
                <button
                  disabled={alreadyKnown || isAdding}
                  onClick={() => handleAdd(slug)}
                  style={{
                    padding: '6px 12px', fontSize: 11, fontWeight: 700,
                    background: alreadyKnown ? 'transparent' : C.gold,
                    color: alreadyKnown ? C.textMuted : '#1a1a1a',
                    border: `1px solid ${alreadyKnown ? C.borderDim : C.gold}`,
                    borderRadius: 4,
                    cursor: alreadyKnown ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit', textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {isAdding ? '...' : alreadyKnown ? 'Added' : 'Add'}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 8, fontSize: 10, color: C.textMuted, textAlign: 'center' }}>
          Click <b>Add</b> to grant the spell. Spells with damage / saves are auto-parsed from the description.
        </div>
      </div>
    </div>
  );
}

function SpellsTab({ spells: rawSpells, spellSlots, spellcastingAbility, spellAttackBonus, spellSaveDC, abilityScores, profBonus, characterId, characterLevel, isDM, isOwner }: {
  spells: Spell[];
  spellSlots: Record<number, SpellSlot>;
  spellcastingAbility: string;
  spellAttackBonus: number;
  spellSaveDC: number;
  abilityScores: AbilityScores;
  profBonus: number;
  characterId: string;
  characterLevel: number;
  isDM: boolean;
  isOwner: boolean;
}) {
  const [showAddSpell, setShowAddSpell] = useState(false);
  const canEdit = isDM || isOwner;
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // DM override for spell slots — when ON, every leveled spell is castable
  // regardless of slot count, and casting doesn't consume slots.
  const dmIgnoreSpellSlots = useSessionStore((s) => s.dmIgnoreSpellSlots);
  const setDmIgnoreSpellSlots = useSessionStore((s) => s.setDmIgnoreSpellSlots);

  // Enrich every spell from its description so DDB-imported spells (which
  // often have null damage / save / attack fields) display the same as
  // freshly added compendium spells. This is non-destructive — the cast
  // resolver does the same parsing as a fallback, but the SPELL LIST view
  // only reads the structured field, so without enrichment the user sees
  // a blank "1d10 fire" line.
  const spells = useMemo(
    () => rawSpells.map(enrichSpellFromDescription),
    [rawSpells],
  );

  const scAbility = (spellcastingAbility || 'int') as AbilityName;
  const scMod = abilityModifier(abilityScores[scAbility] ?? 10);

  // Split cantrips from leveled spells
  const cantrips = useMemo(() => spells.filter(s => s.level === 0).filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase())
  ), [spells, search]);

  const leveledSpells = useMemo(() => {
    const map: Record<number, Spell[]> = {};
    const filtered = spells.filter(s => {
      if (s.level === 0) return false;
      if (levelFilter !== null && s.level !== levelFilter) return false;
      if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    for (const s of filtered) (map[s.level] ??= []).push(s);
    return map;
  }, [spells, levelFilter, search]);

  const levels = Object.keys(leveledSpells).map(Number).sort((a, b) => a - b);
  const allLevels = useMemo(() => Array.from(new Set(spells.filter(s => s.level > 0).map(s => s.level))).sort((a, b) => a - b), [spells]);

  const toggleExpand = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  // Toggle spell slot (click to expend/restore)
  const toggleSlot = (level: number, index: number) => {
    const slot = spellSlots[level];
    if (!slot) return;
    const newUsed = index < slot.used ? index : index + 1;
    const updatedSlots = { ...spellSlots, [level]: { ...slot, used: newUsed } };
    emitCharacterUpdate(characterId, { spellSlots: updatedSlots });
    useCharacterStore.getState().applyRemoteUpdate(characterId, { spellSlots: updatedSlots });
  };

  const getSpellSlug = (name: string) => name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/'/g, '');

  // Helpers that mutate the spells array. We use rawSpells (the unenriched
  // source) so we don't accidentally write display-only enriched fields
  // back to the database.
  const addSpell = (spell: Spell) => {
    const exists = rawSpells.some(s => s.name.toLowerCase() === spell.name.toLowerCase());
    if (exists) return;
    const updated = [...rawSpells, spell];
    emitCharacterUpdate(characterId, { spells: updated });
  };

  const removeSpell = (spellName: string) => {
    const updated = rawSpells.filter(s => s.name.toLowerCase() !== spellName.toLowerCase());
    emitCharacterUpdate(characterId, { spells: updated });
  };

  // Toggle the per-spell DM override flag. When ON, this specific spell
  // can be cast without consuming a slot, even if no slot is available.
  // Useful for granting individual story-moment spells without enabling
  // the global override.
  const toggleSpellOverride = (spellName: string) => {
    const updated = rawSpells.map(s => s.name.toLowerCase() === spellName.toLowerCase()
      ? { ...s, dmOverride: !s.dmOverride }
      : s,
    );
    emitCharacterUpdate(characterId, { spells: updated });
  };

  const existingSpellNames = useMemo(
    () => new Set(spells.map(s => s.name.toLowerCase())),
    [spells],
  );

  if (spells.length === 0) {
    return (
      <div style={{ color: C.textMuted, textAlign: 'center', padding: 40, fontSize: 13 }}>
        <div style={{ marginBottom: 12 }}>No spells known.</div>
        {canEdit && (
          <button onClick={() => setShowAddSpell(true)} style={{
            padding: '8px 18px', fontSize: 12, fontWeight: 700,
            background: C.gold, color: '#1a1a1a',
            border: `1px solid ${C.gold}`, borderRadius: 4,
            cursor: 'pointer', fontFamily: 'inherit',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>+ Add Spell</button>
        )}
        {showAddSpell && (
          <AddSpellDialog
            existingSpellNames={existingSpellNames}
            onAdd={addSpell}
            onClose={() => setShowAddSpell(false)}
          />
        )}
      </div>
    );
  }

  const renderSpellRow = (spell: Spell, i: number) => {
    const key = `${spell.name}-${spell.level}`;
    const isExp = expanded[key];
    const slug = getSpellSlug(spell.name);
    const schoolColor = SCHOOL_COLORS[spell.school] || C.textMuted;

    // Determine spent state for leveled spells (cantrips never go spent).
    // Two DM overrides bypass it: the GLOBAL toggle (dmIgnoreSpellSlots),
    // and a PER-SPELL flag (spell.dmOverride) for granting individual
    // story-moment spells without unlocking everything.
    const slot = spell.level > 0 ? spellSlots[spell.level] : null;
    const slotsLeft = slot ? slot.max - slot.used : 0;
    const slotsMax = slot ? slot.max : 0;
    const overridden = dmIgnoreSpellSlots || !!spell.dmOverride;
    const isSpent = !overridden && spell.level > 0 && slot ? slotsLeft <= 0 : false;
    const tooltip = spell.level === 0
      ? `${spell.name} — Cantrip (at will, never expended)`
      : spell.dmOverride
        ? `${spell.name} — DM override on this spell (slots bypassed)`
        : dmIgnoreSpellSlots
          ? `${spell.name} — DM override active, slots bypassed`
          : isSpent
            ? `${spell.name} — Out of level ${spell.level} slots (0/${slotsMax}). Long Rest to recharge.`
            : `${spell.name} — Level ${spell.level} (${slotsLeft}/${slotsMax} slots left, Long Rest to recharge)`;

    return (
      <div key={i} title={tooltip} style={{
        background: C.bgCard, borderRadius: 4,
        border: `1px solid ${isSpent ? C.borderDim : C.borderDim}`, marginBottom: 2,
        overflow: 'hidden',
        opacity: isSpent ? 0.5 : 1,
      }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer' }}
          onClick={() => toggleExpand(key)}
          onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          {/* Spell image */}
          <img src={`/uploads/spells/${slug}.png`} alt="" loading="lazy"
            style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: `1.5px solid ${schoolColor}`, filter: isSpent ? 'grayscale(60%)' : 'none' }}
            onError={e => { (e.currentTarget).src = '/uploads/items/default-item.svg'; }}
          />
          {/* Name + badges */}
          <div
            style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                detail: { slug, category: 'spells', name: spell.name },
              }));
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12, color: isSpent ? C.textMuted : schoolColor, textDecoration: isSpent ? 'line-through' : 'none' }}>
              {spell.name}
              {isSpent && <span style={{ color: C.red, marginLeft: 6, fontSize: 9, fontWeight: 700 }}>SPENT</span>}
              {spell.dmOverride && <span style={{ color: '#b185db', marginLeft: 6, fontSize: 9, fontWeight: 700 }} title="DM override active on this spell — slots ignored">🔓 OVERRIDE</span>}
            </div>
            <div style={{ fontSize: 9, color: C.textMuted }}>
              {spell.school}
              {spell.isConcentration && <span style={{ color: C.gold, marginLeft: 4 }}>Concentration</span>}
              {spell.isRitual && <span style={{ color: C.purple, marginLeft: 4 }}>Ritual</span>}
              {spell.damage && <span style={{ color: C.red, marginLeft: 4 }}>{spell.damage} {spell.damageType || ''}</span>}
              {spell.savingThrow && <span style={{ color: C.gold, marginLeft: 4 }}>DC {spellSaveDC} {spell.savingThrow.toUpperCase()}</span>}
              {slot && <span style={{ color: isSpent ? C.red : C.gold, marginLeft: 4 }}>{slotsLeft}/{slotsMax} slots</span>}
            </div>
          </div>
          {/* Quick cast */}
          <button
            disabled={isSpent}
            onClick={e => {
              e.stopPropagation();
              if (isSpent) return;
              if (spell.attackType) {
                emitRoll(`1d20${fmtMod(spellAttackBonus)}`, `${spell.name} Attack`);
              } else if (spell.damage) {
                showRollToast(spell.damage, `${spell.name} Damage`);
              }
            }}
            style={{
              background: isSpent ? 'transparent' : schoolColor + '22',
              color: isSpent ? C.textMuted : schoolColor,
              border: `1px solid ${isSpent ? C.borderDim : schoolColor + '44'}`,
              borderRadius: 3, padding: '2px 8px', fontSize: 9,
              cursor: isSpent ? 'not-allowed' : 'pointer', fontWeight: 700,
              flexShrink: 0, fontFamily: 'inherit', textTransform: 'uppercase',
            }}
          >{isSpent ? 'Spent' : 'Cast'}</button>
          <span style={{ fontSize: 10, color: C.textMuted }}>{isExp ? '\u25B2' : '\u25BC'}</span>
        </div>

        {/* Expanded details */}
        {isExp && (
          <div style={{ padding: '8px 12px', borderTop: `1px solid ${C.borderDim}`, background: C.bgElevated, fontSize: 11, lineHeight: 1.5 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: schoolColor + '22', color: schoolColor, border: `1px solid ${schoolColor}44` }}>
                {spell.school}
              </span>
              <span><b style={{ color: C.textMuted }}>Cast:</b> {spell.castingTime}</span>
              <span><b style={{ color: C.textMuted }}>Range:</b> {spell.range}</span>
              <span><b style={{ color: C.textMuted }}>Components:</b> {spell.components}</span>
              <span><b style={{ color: C.textMuted }}>Duration:</b> {spell.duration}</span>
            </div>
            {spell.damage && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <RollButton notation={spell.damage} reason={`${spell.name} Damage`} label="Roll Damage" />
                {spell.attackType && <RollButton notation={`1d20${fmtMod(spellAttackBonus)}`} reason={`${spell.name} Attack`} label="Roll Attack" />}
              </div>
            )}
            <div style={{ color: C.textSecondary, whiteSpace: 'pre-wrap' }}>{stripHtml(spell.description)}</div>
            {spell.higherLevels && (
              <div style={{ marginTop: 6, color: C.blue }}><b>At Higher Levels:</b> {spell.higherLevels}</div>
            )}
            {/* DM/owner: per-spell DM override + remove */}
            {canEdit && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.borderDim}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {isDM && spell.level > 0 ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSpellOverride(spell.name);
                    }}
                    title="Bypass slot consumption and requirements for this specific spell. Useful for story moments where the DM grants a temporary spell awakening."
                    style={{
                      padding: '4px 10px', fontSize: 10, fontWeight: 600,
                      background: spell.dmOverride ? 'rgba(155,89,182,0.2)' : 'transparent',
                      color: spell.dmOverride ? '#b185db' : C.textMuted,
                      border: `1px solid ${spell.dmOverride ? '#9b59b6' : C.borderDim}`,
                      borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    🔓 {spell.dmOverride ? 'Override ON' : 'DM: Ignore slots'}
                  </button>
                ) : <span />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Remove "${spell.name}" from this character? Note: a fresh DDB import will add it back if the character has it on D&D Beyond.`)) {
                      removeSpell(spell.name);
                    }
                  }}
                  title="Remove spell from character (will be re-added on next DDB import)"
                  style={{
                    padding: '4px 10px', fontSize: 10, fontWeight: 600,
                    background: 'transparent', color: C.red,
                    border: `1px solid ${C.red}44`, borderRadius: 3,
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  🗑 Remove Spell
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Spellcasting stats */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { label: 'Modifier', value: fmtMod(scMod) },
          { label: 'Spell Attack', value: fmtMod(spellAttackBonus) },
          { label: 'Save DC', value: String(spellSaveDC) },
        ].map(s => (
          <div key={s.label} style={{ background: C.bgCard, border: `1px solid ${C.borderDim}`, borderRadius: 6, padding: '6px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{s.value}</div>
          </div>
        ))}
        {/* DM-only: bypass spell slot requirements */}
        {isDM && (
          <button
            onClick={() => setDmIgnoreSpellSlots(!dmIgnoreSpellSlots)}
            title="Bypass spell slot consumption and requirements. Useful for testing and story moments where the DM grants a temporary spell. The chat header will mark each cast as a DM override."
            style={{
              marginLeft: 'auto',
              padding: '8px 14px', fontSize: 10, fontWeight: 700,
              background: dmIgnoreSpellSlots ? 'rgba(155,89,182,0.2)' : 'transparent',
              color: dmIgnoreSpellSlots ? '#b185db' : C.textMuted,
              border: `1px solid ${dmIgnoreSpellSlots ? '#9b59b6' : C.borderDim}`,
              borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}
          >
            🔓 {dmIgnoreSpellSlots ? 'DM Override ON' : 'DM Override Off'}
          </button>
        )}
        {canEdit && (
          <button onClick={() => setShowAddSpell(true)} style={{
            marginLeft: isDM ? 0 : 'auto',
            padding: '8px 16px', fontSize: 11, fontWeight: 700,
            background: C.gold, color: '#1a1a1a',
            border: `1px solid ${C.gold}`, borderRadius: 4,
            cursor: 'pointer', fontFamily: 'inherit',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>+ Add Spell</button>
        )}
      </div>
      {/* DM override active banner */}
      {dmIgnoreSpellSlots && isDM && (
        <div style={{
          marginBottom: 8, padding: '6px 10px',
          background: 'rgba(155,89,182,0.1)',
          border: '1px solid rgba(155,89,182,0.4)',
          borderRadius: 4, fontSize: 11, color: '#b185db',
          textAlign: 'center', fontStyle: 'italic',
        }}>
          🔓 DM Override active — all leveled spells are castable, no slots consumed. Click the button above to turn off.
        </div>
      )}

      {/* Add Spell modal */}
      {showAddSpell && (
        <AddSpellDialog
          existingSpellNames={existingSpellNames}
          onAdd={addSpell}
          onClose={() => setShowAddSpell(false)}
        />
      )}

      {/* Search */}
      <input type="text" placeholder="Search spells..." value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: '6px 10px', marginBottom: 8, background: C.bgElevated, border: `1px solid ${C.border}`,
          borderRadius: 6, color: C.textPrimary, fontSize: 12, outline: 'none', boxSizing: 'border-box' }} />

      {/* Cantrips section */}
      {cantrips.length > 0 && (levelFilter === null || levelFilter === 0) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.borderDim}`, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.gold, textTransform: 'uppercase' }}>Cantrips</span>
            <span style={{ fontSize: 9, color: C.textMuted, marginLeft: 'auto' }}>At Will</span>
          </div>
          {cantrips.map((spell, i) => renderSpellRow(spell, i))}
        </div>
      )}

      {/* Level filter pills (for leveled spells only) */}
      {allLevels.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
          <Pill active={levelFilter === null} onClick={() => setLevelFilter(null)}>ALL</Pill>
          {allLevels.map(l => (
            <Pill key={l} active={levelFilter === l} onClick={() => setLevelFilter(l)}>{levelPillLabel(l)}</Pill>
          ))}
        </div>
      )}

      {/* Leveled spell groups */}
      {levels.map(level => {
        const slot = spellSlots[level];
        const group = leveledSpells[level];
        const slotsAvail = slot ? slot.max - slot.used : 0;
        return (
          <div key={level} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.borderDim}`, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.red, textTransform: 'uppercase' }}>
                {ordinal(level)} Level
              </span>
              {/* Interactive slot pips */}
              {slot && (
                <div style={{ display: 'flex', gap: 3, marginLeft: 'auto', alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: slotsAvail > 0 ? C.textSecondary : C.red, marginRight: 4, fontWeight: 600 }}>
                    {slotsAvail}/{slot.max}
                  </span>
                  {Array.from({ length: slot.max }).map((_, i) => (
                    <SlotPip key={i} filled={i >= slot.used}
                      onClick={() => toggleSlot(level, i)} />
                  ))}
                </div>
              )}
            </div>
            {slotsAvail === 0 && slot && (
              <div style={{ fontSize: 9, color: C.red, fontStyle: 'italic', marginBottom: 4 }}>No spell slots remaining</div>
            )}
            {group.map((spell, i) => renderSpellRow(spell, i))}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: INVENTORY
   ═══════════════════════════════════════════════════════════ */
type InvFilter = 'all' | 'equipment' | 'backpack' | 'attunement';
const INV_FILTERS: { key: InvFilter; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'equipment', label: 'EQUIPMENT' },
  { key: 'backpack', label: 'BACKPACK' },
  { key: 'attunement', label: 'ATTUNEMENT' },
];

function InventoryTab({ inventory, currency, characterId }: { inventory: InventoryItem[]; currency: CharacterCurrency; characterId: string }) {
  const [filter, setFilter] = useState<InvFilter>('all');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const totalWeight = inventory.reduce((sum, i) => sum + i.weight * i.quantity, 0);
  const totalGP = currency.pp * 10 + currency.gp + currency.ep * 0.5 + currency.sp * 0.1 + currency.cp * 0.01;

  const filtered = inventory.filter(i => {
    if (filter === 'equipment') return i.equipped;
    if (filter === 'backpack') return !i.equipped;
    if (filter === 'attunement') return i.attunement;
    return true;
  });

  return (
    <div>
      {/* Sub-filters */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {INV_FILTERS.map(f => (
          <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Pill>
        ))}
      </div>

      {/* Weight & Currency */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11 }}>
        <span style={{ color: C.textSecondary }}>
          Weight: <b style={{ color: C.textPrimary }}>{totalWeight.toFixed(1)} lb</b>
        </span>
        <span style={{ color: C.textSecondary }}>
          Currency: <b style={{ color: C.gold }}>{totalGP.toFixed(0)} GP</b>
          <span style={{ color: C.textMuted, marginLeft: 6 }}>
            ({currency.pp}pp, {currency.gp}gp, {currency.ep}ep, {currency.sp}sp, {currency.cp}cp)
          </span>
        </span>
      </div>

      {/* Item rows */}
      {filtered.length === 0 && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: 40, fontSize: 13 }}>
          No items{filter !== 'all' ? ' in this category' : ''}.
        </div>
      )}
      {filtered.map((item, i) => {
        const isExpanded = expanded[i];
        return (
          <div key={i} style={{
            background: C.bgCard, borderRadius: 4,
            border: `1px solid ${C.borderDim}`, marginBottom: 2,
            overflow: 'hidden',
          }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', cursor: 'pointer',
              }}
              onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))}
              onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {/* Equipped toggle */}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  const updated = [...inventory];
                  updated[i] = { ...item, equipped: !item.equipped };
                  emitCharacterUpdate(characterId, { inventory: updated });
                  useCharacterStore.getState().applyRemoteUpdate(characterId, { inventory: updated });
                }}
                title={item.equipped ? 'Equipped — click to unequip' : 'Click to equip'}
                style={{
                  width: 16, height: 16, borderRadius: 3, cursor: 'pointer',
                  border: `2px solid ${item.equipped ? C.red : C.textDim}`,
                  background: item.equipped ? C.red : 'transparent',
                  flexShrink: 0, transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, color: item.equipped ? '#fff' : 'transparent',
                }}
              >{item.equipped ? 'E' : ''}</span>
              {/* Item image */}
              <img
                src={(item as any).imageUrl || ((item as any).slug ? `/uploads/items/${(item as any).slug}.png` : '')}
                alt=""
                loading="lazy"
                style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
                  border: `1.5px solid ${RARITY_COLORS[(item.rarity || 'common').toLowerCase()] || C.borderDim}` }}
                onError={e => { (e.currentTarget).src = '/uploads/items/default-item.svg'; }}
              />
              <div
                style={{ flex: 1, minWidth: 0, cursor: (item as any).slug ? 'pointer' : 'default' }}
                onClick={(e) => {
                  const slug = (item as any).slug;
                  if (slug) {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent('open-compendium-detail', {
                      detail: { slug, category: 'items', name: item.name },
                    }));
                  }
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, color: RARITY_COLORS[(item.rarity || '').toLowerCase()] || C.textPrimary }}>{item.name}</div>
                <div style={{ fontSize: 9, color: C.textMuted }}>
                  {item.type}{item.attuned ? ' (attuned)' : ''}
                  {item.damage && <span style={{ color: C.red, marginLeft: 4 }}>{item.damage} {item.damageType || ''}</span>}
                  {(item as any).acBonus && <span style={{ color: '#3498db', marginLeft: 4 }}>AC +{(item as any).acBonus}</span>}
                </div>
              </div>
              <span style={{ fontSize: 10, color: C.textSecondary, minWidth: 20, textAlign: 'center', fontWeight: 700 }}>
                x{item.quantity}
              </span>
              <span style={{ fontSize: 10, color: C.textMuted }}>
                {isExpanded ? '\u25B2' : '\u25BC'}
              </span>
            </div>

            {isExpanded && (
              <div style={{
                padding: '8px 12px', borderTop: `1px solid ${C.borderDim}`,
                background: C.bgElevated, fontSize: 11, lineHeight: 1.5,
              }}>
                {item.description && (
                  <div style={{ color: C.textSecondary, marginBottom: 6, whiteSpace: 'pre-wrap' }}>{stripHtml(item.description)}</div>
                )}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {item.damage && <span><b style={{ color: C.textMuted }}>Damage:</b> {item.damage} {item.damageType ?? ''}</span>}
                  {item.properties && item.properties.length > 0 && (
                    <span><b style={{ color: C.textMuted }}>Properties:</b> {item.properties.join(', ')}</span>
                  )}
                  {item.attunement && <Badge color={item.attuned ? C.red : C.textDim}>{item.attuned ? 'Attuned' : 'Requires Attunement'}</Badge>}
                </div>
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {item.type === 'weapon' && item.damage && (
                    <RollButton notation={item.damage} reason={`${item.name} Damage`} label="Roll Damage" />
                  )}
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        // Find position near the character's token
                        const mapState = useMapStore.getState();
                        const currentMap = mapState.currentMap;
                        if (!currentMap) { alert('No map loaded'); return; }
                        const tokens = mapState.tokens;
                        const myToken = Object.values(tokens).find((t: any) => t.characterId === characterId);
                        const dropX = myToken ? (myToken as any).x + 70 : currentMap.width / 2;
                        const dropY = myToken ? (myToken as any).y : currentMap.height / 2;

                        // Server handles everything: removes from inventory, creates loot character + entry
                        const resp = await fetch(`/api/characters/${characterId}/loot/drop`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ itemIndex: i, mapId: currentMap.id, x: dropX, y: dropY }),
                        });
                        if (!resp.ok) { console.error('Drop failed:', await resp.text()); return; }
                        const data = await resp.json();

                        // Update local inventory
                        useCharacterStore.getState().applyRemoteUpdate(characterId, { inventory: data.inventory });

                        // Spawn the token via socket
                        if (data.token) {
                          emitTokenAdd(data.token);
                        }
                      } catch (err) { console.error('Drop item failed:', err); }
                    }}
                    style={{
                      padding: '3px 8px', fontSize: 10, fontWeight: 600, borderRadius: 4,
                      background: 'rgba(212,168,67,0.1)', border: '1px solid rgba(212,168,67,0.3)',
                      color: C.gold, cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >Drop on Map</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: FEATURES & TRAITS
   ═══════════════════════════════════════════════════════════ */
type FeatFilter = 'all' | 'class' | 'race' | 'feat';
const FEAT_FILTERS: { key: FeatFilter; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'class', label: 'CLASS FEATURES' },
  { key: 'race', label: 'SPECIES TRAITS' },
  { key: 'feat', label: 'FEATS' },
];

function FeaturesTab({ features }: { features: Feature[] }) {
  const [filter, setFilter] = useState<FeatFilter>('all');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const filtered = features.filter(f => {
    if (filter === 'class') return f.sourceType === 'class';
    if (filter === 'race') return f.sourceType === 'race';
    if (filter === 'feat') return f.sourceType === 'feat';
    return true;
  });

  return (
    <div>
      {/* Sub-filters */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {FEAT_FILTERS.map(f => (
          <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Pill>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ color: C.textMuted, textAlign: 'center', padding: 40, fontSize: 13 }}>
          No features{filter !== 'all' ? ' in this category' : ''}.
        </div>
      )}

      {filtered.map((feat, i) => {
        const isExpanded = expanded[i];
        const hasUses = feat.usesTotal != null && feat.usesTotal > 0;
        const usesLeft = feat.usesRemaining ?? feat.usesTotal ?? 0;
        const isSpent = hasUses && usesLeft <= 0;
        const rechargeLabel = feat.resetOn === 'short' ? 'Short Rest' : feat.resetOn === 'long' ? 'Long Rest' : feat.resetOn === 'dawn' ? 'Dawn' : 'Long Rest';
        const tooltip = !hasUses
          ? `${feat.name} — Always available (${feat.source})`
          : isSpent
            ? `${feat.name} — All uses spent (0/${feat.usesTotal}). Recharges on ${rechargeLabel}.`
            : `${feat.name} — ${usesLeft}/${feat.usesTotal} uses remaining. Recharges on ${rechargeLabel}.`;
        return (
          <div key={i} title={tooltip} style={{
            background: C.bgCard, borderRadius: 4,
            border: `1px solid ${C.borderDim}`, marginBottom: 4,
            overflow: 'hidden',
            opacity: isSpent ? 0.5 : 1,
          }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', cursor: 'pointer',
              }}
              onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))}
              onMouseEnter={e => (e.currentTarget.style.background = C.bgHover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 13, textDecoration: isSpent ? 'line-through' : 'none', color: isSpent ? C.textMuted : C.textPrimary }}>
                  {feat.name}
                </span>
                <span style={{ fontSize: 10, color: C.textMuted, marginLeft: 8 }}>{feat.source}</span>
                {isSpent && <span style={{ color: C.red, marginLeft: 6, fontSize: 9, fontWeight: 700 }}>SPENT</span>}
              </div>
              {/* Usage pips + count */}
              {hasUses && (
                <>
                  <span style={{ fontSize: 10, color: isSpent ? C.red : C.textSecondary, fontWeight: 600 }}>
                    {usesLeft}/{feat.usesTotal}
                  </span>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    {Array.from({ length: feat.usesTotal! }).map((_, j) => (
                      <span key={j} style={{
                        width: 12, height: 12, borderRadius: '50%',
                        border: `2px solid ${C.red}`,
                        background: j < usesLeft ? C.red : 'transparent',
                        display: 'inline-block',
                      }} />
                    ))}
                  </div>
                </>
              )}
              {feat.resetOn && (
                <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase' }}>
                  {feat.resetOn === 'short' ? 'Short Rest' : feat.resetOn === 'long' ? 'Long Rest' : feat.resetOn}
                </span>
              )}
              <span style={{ fontSize: 12, color: C.textMuted }}>
                {isExpanded ? '\u25B2' : '\u25BC'}
              </span>
            </div>

            {isExpanded && (
              <div style={{
                padding: '8px 12px', borderTop: `1px solid ${C.borderDim}`,
                background: C.bgElevated, fontSize: 11, lineHeight: 1.5,
                color: C.textSecondary, whiteSpace: 'pre-wrap',
              }}>
                {stripHtml(feat.description)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: BACKGROUND
   ═══════════════════════════════════════════════════════════ */
function BackgroundTab({ background, characteristics, personality }: {
  background: CharacterBackground;
  characteristics: CharacterCharacteristics;
  personality: CharacterPersonality;
}) {
  const charFields: [string, string][] = [
    ['Alignment', characteristics.alignment],
    ['Gender', characteristics.gender],
    ['Size', characteristics.size],
    ['Age', characteristics.age],
    ['Height', characteristics.height],
    ['Weight', characteristics.weight],
    ['Eyes', characteristics.eyes],
    ['Hair', characteristics.hair],
    ['Skin', characteristics.skin],
    ['Faith', characteristics.faith],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div>
      {/* Background name & description */}
      {background.name && (
        <>
          <SectionHeader>Background: {background.name}</SectionHeader>
          {background.description && (
            <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap' }}>
              {stripHtml(background.description)}
            </div>
          )}
          {background.feature && (
            <div style={{
              background: C.bgCard, padding: '8px 12px', borderRadius: 4,
              border: `1px solid ${C.borderDim}`, marginBottom: 12,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.red, marginBottom: 4 }}>Background Feature</div>
              <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{background.feature}</div>
            </div>
          )}
        </>
      )}

      {/* Characteristics grid */}
      {charFields.length > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Characteristics</SectionHeader>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 6, marginBottom: 12,
          }}>
            {charFields.map(([label, value]) => (
              <div key={label} style={{
                background: C.bgCard, padding: '6px 10px', borderRadius: 4,
                border: `1px solid ${C.borderDim}`,
              }}>
                <div style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 12, color: C.textPrimary }}>{value}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Personality sections */}
      {([
        ['Personality Traits', personality.traits],
        ['Ideals', personality.ideals],
        ['Bonds', personality.bonds],
        ['Flaws', personality.flaws],
      ] as const).map(([label, text]) => {
        if (!text) return null;
        return (
          <div key={label} style={{ marginBottom: 12 }}>
            <SectionHeader>{label}</SectionHeader>
            <div style={{
              fontSize: 12, color: C.textSecondary, lineHeight: 1.5,
              padding: '6px 10px', background: C.bgCard,
              borderRadius: 4, border: `1px solid ${C.borderDim}`,
              whiteSpace: 'pre-wrap',
            }}>
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TAB: NOTES
   ═══════════════════════════════════════════════════════════ */
function NotesTab({ notes }: { notes: CharacterNotes }) {
  const sections: { key: keyof CharacterNotes; label: string }[] = [
    { key: 'organizations', label: 'Organizations' },
    { key: 'allies', label: 'Allies' },
    { key: 'enemies', label: 'Enemies' },
    { key: 'backstory', label: 'Backstory' },
    { key: 'other', label: 'Other' },
  ];

  return (
    <div>
      {sections.map(({ key, label }) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <SectionHeader>{label}</SectionHeader>
          <textarea
            defaultValue={notes[key] ?? ''}
            placeholder={`${label}...`}
            style={{
              width: '100%', minHeight: 80, padding: '8px 10px',
              background: C.bgCard, border: `1px solid ${C.border}`,
              borderRadius: 4, color: C.textPrimary, fontSize: 12,
              lineHeight: 1.5, resize: 'vertical', outline: 'none',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = C.red)}
            onBlur={e => (e.currentTarget.style.borderColor = C.border)}
          />
        </div>
      ))}
    </div>
  );
}
