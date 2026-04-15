import type { CharacterNotes } from '@dnd-vtt/shared';
import { C, SectionHeader } from '../shared';

/**
 * Character sheet "Notes" tab. Six free-text sections \u2014 organizations,
 * allies, enemies, backstory, other \u2014 rendered as textareas the
 * player can edit.
 *
 * Note: the textareas use `defaultValue` and don't yet persist on blur
 * (pre-existing limitation \u2014 flagged by the UX audit as a data loss
 * risk for unsaved edits).
 */
export function NotesTab({ notes }: { notes: CharacterNotes }) {
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
              width: '100%',
              minHeight: 80,
              padding: '8px 10px',
              background: C.bgCard,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              color: C.textPrimary,
              fontSize: 12,
              lineHeight: 1.5,
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = C.red)}
            onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
          />
        </div>
      ))}
    </div>
  );
}
