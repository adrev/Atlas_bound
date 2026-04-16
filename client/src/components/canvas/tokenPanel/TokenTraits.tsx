import { C } from './styles';
import { Section } from './Section';

interface Trait {
  name: string;
  desc?: string;
}

/**
 * Creature traits (Amphibious, Pack Tactics, etc.) pulled from the
 * compendium's `special_abilities`. First three are shown with a
 * short description preview; users can open the compendium popup
 * for the full text.
 */
export function TokenTraits({ traits }: { traits: Trait[] }) {
  if (!traits || traits.length === 0) return null;
  return (
    <Section title="Traits">
      {traits.slice(0, 3).map((trait, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text }}>{trait.name}. </span>
          <span style={{ fontSize: 9, color: C.textMuted }}>
            {trait.desc?.substring(0, 60)}
            {trait.desc && trait.desc.length > 60 ? '\u2026' : ''}
          </span>
        </div>
      ))}
    </Section>
  );
}
