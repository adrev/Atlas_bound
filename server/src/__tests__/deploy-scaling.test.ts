import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Cloud Run deployment defaults', () => {
  it('retains zero minimums and request-based CPU allocation on future releases', () => {
    const script = readFileSync(new URL('../../../deploy.sh', import.meta.url), 'utf8');
    const command = script.slice(script.lastIndexOf('gcloud run deploy'));
    expect(command).toMatch(/--min\s+0\s+\\/);
    expect(command).toMatch(/--min-instances\s+0\s+\\/);
    expect(command).toMatch(/--cpu-throttling\s+\\/);
    expect(command).not.toContain('--no-cpu-throttling');
  });
});
