/**
 * Chronicler tests — pure-function prompt + parser assertions, plus
 * a happy-path test of generateChronicle() with a stubbed Vertex
 * client. The real Gemini call is never made in tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildChroniclerRequest,
  parseChroniclerResponse,
  generateChronicle,
  isChroniclerError,
  setVertexClientForTesting,
} from '../services/Chronicler.js';

describe('buildChroniclerRequest', () => {
  it('emits a system instruction + user content with the transcript', () => {
    const req = buildChroniclerRequest({
      campaignName: 'Mists of Thornreach',
      sequenceNumber: 7,
      transcript: 'Liraya rolled a natural 20.\nThe goblins fled.',
    });

    expect(req.systemInstruction).toBeTruthy();
    const sysParts = (req.systemInstruction as { parts: { text: string }[] }).parts;
    expect(sysParts[0].text).toMatch(/Chronicler/);
    expect(sysParts[0].text).toMatch(/JSON/);

    const userText = (req.contents[0].parts[0] as { text: string }).text;
    expect(userText).toContain('Mists of Thornreach');
    expect(userText).toContain('Session number: 7');
    expect(userText).toContain('Liraya rolled a natural 20.');
  });

  it('binds the response schema and JSON mime type', () => {
    const req = buildChroniclerRequest({
      campaignName: 'X', sequenceNumber: 1, transcript: 'something happened',
    });
    expect(req.generationConfig?.responseMimeType).toBe('application/json');
    const schema = req.generationConfig?.responseSchema as any;
    expect(schema.required).toEqual(['recapShort', 'recapFull', 'keyEntities', 'whereLeftOff']);
  });

  it('trims very long transcripts from the head, keeping the tail', () => {
    const big = 'a'.repeat(50_000);
    const req = buildChroniclerRequest({
      campaignName: 'X', sequenceNumber: 1, transcript: big + 'TAIL',
    });
    const userText = (req.contents[0].parts[0] as { text: string }).text;
    // The trim notice is included.
    expect(userText).toMatch(/transcript trimmed at the head/);
    // The literal end of the transcript is preserved.
    expect(userText).toContain('TAIL');
    // The bulk of the head 'aaaa…' was dropped.
    expect(userText.length).toBeLessThan(big.length);
  });

  it('surfaces party names + timing when provided', () => {
    const req = buildChroniclerRequest({
      campaignName: 'C',
      sequenceNumber: 3,
      transcript: 'something',
      partyNames: ['Liraya', 'Bren'],
      sessionStartedAt: '2026-04-27T19:00:00Z',
      sessionEndedAt: '2026-04-27T22:18:00Z',
    });
    const userText = (req.contents[0].parts[0] as { text: string }).text;
    expect(userText).toContain('Liraya, Bren');
    expect(userText).toContain('19:00:00Z');
  });
});

describe('parseChroniclerResponse', () => {
  it('returns the typed shape for a well-formed JSON response', () => {
    const result = parseChroniclerResponse(JSON.stringify({
      recapShort: 'The party slew the dragon.',
      recapFull: 'After a long battle, the dragon fell.',
      keyEntities: ['Liraya', 'Bren', 'Thorndor'],
      whereLeftOff: 'The smoke clears. Your move, Bren.',
    }));
    expect(isChroniclerError(result)).toBe(false);
    if (!isChroniclerError(result)) {
      expect(result.recapShort).toContain('slew');
      expect(result.keyEntities).toHaveLength(3);
    }
  });

  it('returns an error for non-JSON', () => {
    const result = parseChroniclerResponse('not json at all');
    expect(isChroniclerError(result)).toBe(true);
    if (isChroniclerError(result)) {
      expect(result.error).toMatch(/non-JSON/i);
    }
  });

  it('errors on missing required fields', () => {
    const result = parseChroniclerResponse(JSON.stringify({
      recapShort: '', recapFull: 'x', keyEntities: [], whereLeftOff: 'x',
    }));
    expect(isChroniclerError(result)).toBe(true);
  });

  it('caps key_entities to 12 items and drops non-strings', () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `Entity ${i}`);
    const result = parseChroniclerResponse(JSON.stringify({
      recapShort: 's', recapFull: 'f', keyEntities: [...tooMany, 123, null], whereLeftOff: 'w',
    }));
    expect(isChroniclerError(result)).toBe(false);
    if (!isChroniclerError(result)) {
      expect(result.keyEntities).toHaveLength(12);
      expect(result.keyEntities.every((e) => typeof e === 'string')).toBe(true);
    }
  });
});

describe('generateChronicle (Vertex stub)', () => {
  beforeEach(() => {
    setVertexClientForTesting(null);
  });

  it('refuses inputs with too-short transcripts', async () => {
    const result = await generateChronicle({
      campaignName: 'X', sequenceNumber: 1, transcript: 'eh',
    });
    expect(isChroniclerError(result)).toBe(true);
    if (isChroniclerError(result)) expect(result.error).toMatch(/too short/i);
  });

  it('returns parsed output when the stubbed Vertex client returns valid JSON', async () => {
    const mockGenerate = vi.fn().mockResolvedValue({
      response: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                recapShort: 'The party crossed the moor.',
                recapFull: 'A long crossing of the moor under heavy rain.',
                keyEntities: ['Greyhollow Moor', 'Sera'],
                whereLeftOff: 'Sera looks up. Your move, DM.',
              }),
            }],
          },
        }],
      },
    });
    setVertexClientForTesting({
      getGenerativeModel: () => ({ generateContent: mockGenerate }),
    } as any);

    const result = await generateChronicle({
      campaignName: 'Mists of Thornreach',
      sequenceNumber: 1,
      transcript: 'Lots of stuff happened here. Players rolled dice and so on.',
    });
    expect(isChroniclerError(result)).toBe(false);
    if (!isChroniclerError(result)) {
      expect(result.recapShort).toContain('moor');
      expect(result.keyEntities).toContain('Sera');
    }
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('returns a typed error when Vertex throws', async () => {
    const mockGenerate = vi.fn().mockRejectedValue(new Error('network down'));
    setVertexClientForTesting({
      getGenerativeModel: () => ({ generateContent: mockGenerate }),
    } as any);

    const result = await generateChronicle({
      campaignName: 'C', sequenceNumber: 1, transcript: 'enough text to pass the length gate',
    });
    expect(isChroniclerError(result)).toBe(true);
    if (isChroniclerError(result)) {
      expect(result.error).toMatch(/Vertex/);
      expect(result.hint).toMatch(/network down/);
    }
  });
});
