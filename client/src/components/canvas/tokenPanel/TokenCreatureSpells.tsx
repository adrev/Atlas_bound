import { useMapStore } from '../../../stores/useMapStore';
import { C } from './styles';
import { Section } from './Section';

export interface CreatureSpell {
  name: string;
  level: number;
  slug?: string;
}

/**
 * Spells cast by a creature (parsed from its trait text, e.g. an
 * Archmage's *Spellcasting* block). Rendered as clickable chips that
 * open the spell targeter; right-click opens the compendium popup.
 *
 * Spell slots for creatures are NOT tracked \u2014 5e monsters declare
 * slots in their stat block but the DM enforces them manually, so
 * casts here are always at-will from the panel's perspective.
 */
export function TokenCreatureSpells({
  spells,
  spellDC,
  spellAtk,
  canAct,
  casterTokenId,
  casterName,
}: {
  spells: CreatureSpell[];
  spellDC: number | null;
  spellAtk: number | null;
  canAct: boolean;
  casterTokenId: string | null;
  casterName: string;
}) {
  if (!spells || spells.length === 0) return null;

  const cantrips = spells.filter((s) => s.level === 0);
  const leveled = spells.filter((s) => s.level > 0);

  const startCast = (s: CreatureSpell, range: string) => {
    if (!canAct || !casterTokenId) return;
    useMapStore.getState().startTargetingMode({
      spell: {
        name: s.name,
        level: s.level,
        description: '',
        isConcentration: false,
        isRitual: false,
        school: '',
        castingTime: '1 action',
        range,
        components: '',
        duration: 'Instantaneous',
      },
      casterTokenId,
      casterName,
    });
  };

  const openDetail = (s: CreatureSpell) => {
    if (!s.slug) return;
    window.dispatchEvent(
      new CustomEvent('open-compendium-detail', {
        detail: { slug: s.slug, category: 'spells', name: s.name },
      }),
    );
  };

  return (
    <>
      {cantrips.length > 0 && (
        <Section
          title={`Cantrips (at will)${spellDC ? ` \u00B7 DC ${spellDC}` : ''}`}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {cantrips.map((s, i) => (
              <button
                key={i}
                onClick={() => startCast(s, '30 feet')}
                onContextMenu={(e) => { e.preventDefault(); openDetail(s); }}
                style={{
                  padding: '2px 6px',
                  fontSize: 9,
                  borderRadius: 3,
                  background: C.bgHover,
                  border: `1px solid ${C.borderDim}`,
                  color: C.textSec,
                  cursor: canAct ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        </Section>
      )}
      {leveled.length > 0 && (
        <Section
          title={`Spells${spellAtk ? ` \u00B7 +${spellAtk}` : ''}${spellDC ? ` \u00B7 DC ${spellDC}` : ''}`}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {leveled.map((s, i) => (
              <button
                key={i}
                onClick={() => startCast(s, '60 feet')}
                onContextMenu={(e) => { e.preventDefault(); openDetail(s); }}
                style={{
                  padding: '2px 6px',
                  fontSize: 9,
                  borderRadius: 3,
                  background: C.bgHover,
                  border: `1px solid ${C.borderDim}`,
                  color: C.text,
                  cursor: canAct ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ fontSize: 7, color: C.textMuted, marginRight: 2 }}>L{s.level}</span>
                {s.name}
              </button>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
