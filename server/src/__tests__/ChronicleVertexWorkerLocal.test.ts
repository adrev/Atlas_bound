import { afterEach, expect, it, vi } from 'vitest';
import type { VertexAI } from '@google-cloud/vertexai';
vi.mock('../db/connection.js', () => ({ default: {} }));
import { executeChronicle } from '../services/ChronicleExecution.js';
import { generateChronicle, setVertexClientForTesting } from '../services/Chronicler.js';

afterEach(() => {
  setVertexClientForTesting(null);
});

// Real fresh worker thread, but the length gate exits before client/auth creation.
it('loads the source-mode worker without credentials or model/network calls', async () => {
  const result = await executeChronicle({
    campaignName: 'C',
    sequenceNumber: 1,
    transcript: 'short',
  });
  expect(result).toMatchObject({ error: 'Transcript too short' });
});

it('returns a persistable failure when SDK model initialization throws', async () => {
  setVertexClientForTesting({
    getGenerativeModel: () => {
      throw new Error('configuration failed');
    },
  } as unknown as VertexAI);
  const result = await generateChronicle({
    campaignName: 'C',
    sequenceNumber: 1,
    transcript: 'The party safely crossed the bridge.',
  });
  expect(result).toMatchObject({ error: 'Vertex AI call failed', hint: 'configuration failed' });
});

it('configures a network timeout below the outer worker deadline', async () => {
  const getGenerativeModel = vi
    .fn()
    .mockReturnValue({ generateContent: vi.fn().mockResolvedValue({ response: {} }) });
  setVertexClientForTesting({ getGenerativeModel } as unknown as VertexAI);
  await generateChronicle({
    campaignName: 'C',
    sequenceNumber: 1,
    transcript: 'The party safely crossed the bridge.',
  });
  expect(getGenerativeModel).toHaveBeenCalledWith(expect.any(Object), { timeout: 85_000 });
});
