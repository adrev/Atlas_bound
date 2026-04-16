import { C } from './styles';

/**
 * Stat-block footer showing the creature's senses (darkvision, passive
 * Perception, etc.) and spoken languages, pulled from the compendium.
 * Rendered inline under the actions/weapons/spells sections.
 */
export function TokenSensesLanguages({
  senses,
  languages,
}: {
  senses?: string | null;
  languages?: string | null;
}) {
  if (!senses && !languages) return null;
  return (
    <div style={{ fontSize: 9, color: C.textMuted, marginTop: 4, lineHeight: 1.4 }}>
      {senses && (
        <div>
          <strong style={{ color: C.textSec }}>Senses:</strong> {senses}
        </div>
      )}
      {languages && (
        <div>
          <strong style={{ color: C.textSec }}>Languages:</strong> {languages}
        </div>
      )}
    </div>
  );
}
