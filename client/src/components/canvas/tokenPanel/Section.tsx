import type { ReactNode } from 'react';
import { C } from './styles';

/**
 * Small section header used throughout the TokenActionPanel (Actions,
 * Weapons, Spells, Traits, \u2026). Pulled out of the main panel so
 * every subcomponent renders the same uppercase red-tinted label.
 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          fontSize: 8,
          fontWeight: 700,
          color: C.red,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 3,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
