import { describe, it, expect } from 'vitest';

describe('environment sanity checks', () => {
  it('vitest runs and basic assertions work', () => {
    expect(1 + 1).toBe(2);
  });

  it('can import zod (key server dependency)', async () => {
    const { z } = await import('zod');
    const schema = z.string().min(1);
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse('').success).toBe(false);
  });
});
