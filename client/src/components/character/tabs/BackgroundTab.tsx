import type {
  CharacterBackground, CharacterCharacteristics, CharacterPersonality,
} from '@dnd-vtt/shared';
import { C, SectionHeader, stripHtml } from '../shared';

/**
 * Character sheet "Background" tab. Three groups:
 *  1. Background name + description + special feature
 *  2. Characteristics grid (alignment, gender, size, \u2026)
 *  3. Personality sections (traits, ideals, bonds, flaws)
 *
 * Pure render \u2014 no mutation, no stores. Safe to extract.
 */
export function BackgroundTab({
  background,
  characteristics,
  personality,
}: {
  background: CharacterBackground;
  characteristics: CharacterCharacteristics;
  personality: CharacterPersonality;
}) {
  const charFields: [string, string][] = ([
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
  ] as [string, string | undefined][]).filter(([, v]) => Boolean(v)) as [string, string][];

  return (
    <div>
      {background.name && (
        <>
          <SectionHeader>Background: {background.name}</SectionHeader>
          {background.description && (
            <div
              style={{
                fontSize: 12,
                color: C.textSecondary,
                lineHeight: 1.5,
                marginBottom: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
              {stripHtml(background.description)}
            </div>
          )}
          {background.feature && (
            <div
              style={{
                background: C.bgCard,
                padding: '8px 12px',
                borderRadius: 4,
                border: `1px solid ${C.borderDim}`,
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: C.red, marginBottom: 4 }}>
                Background Feature
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: C.textSecondary,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {background.feature}
              </div>
            </div>
          )}
        </>
      )}

      {charFields.length > 0 && (
        <>
          <SectionHeader style={{ marginTop: 12 }}>Characteristics</SectionHeader>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 6,
              marginBottom: 12,
            }}
          >
            {charFields.map(([label, value]) => (
              <div
                key={label}
                style={{
                  background: C.bgCard,
                  padding: '6px 10px',
                  borderRadius: 4,
                  border: `1px solid ${C.borderDim}`,
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: C.textMuted,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                  }}
                >
                  {label}
                </div>
                <div style={{ fontSize: 12, color: C.textPrimary }}>{value}</div>
              </div>
            ))}
          </div>
        </>
      )}

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
            <div
              style={{
                fontSize: 12,
                color: C.textSecondary,
                lineHeight: 1.5,
                padding: '6px 10px',
                background: C.bgCard,
                borderRadius: 4,
                border: `1px solid ${C.borderDim}`,
                whiteSpace: 'pre-wrap',
              }}
            >
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}
