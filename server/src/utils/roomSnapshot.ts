import type { RoomState } from './roomState.js';
import { z } from 'zod';

const readyCheckSchema = z
  .object({
    id: z.string().min(1),
    deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    playerIds: z.array(z.string()).optional(),
    tokenIds: z.array(z.string().min(1)).min(1),
    responses: z.array(z.tuple([z.string(), z.boolean()])),
  })
  .strict();

const pendingOpportunitiesSchema = z.array(
  z.tuple([
    z.string(),
    z
      .object({
        opportunityId: z.string().min(1),
        attackerTokenId: z.string().min(1),
        attackerOwnerUserId: z.string().nullable(),
        moverTokenId: z.string().min(1),
        trigger: z.enum(['movement', 'spell']),
        issuedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  ])
);

// Explicit allowlist: never persist sockets, presence, timer handles or promises.
const scalarFields = [
  'combatState',
  'music',
  'roundHooks',
  'nextEventId',
  'eventLog',
  'generation',
] as const;
const mapFields = [
  'actionEconomies',
  'dmViewingMap',
  'turnHooks',
  'tokenMeleeReach',
  'legendaryActions',
  'legendaryResistance',
] as const;
const nestedMapFields = ['conditionMeta', 'rechargePools'] as const;
const setFields = ['lairActionTokens', 'polearmMasters'] as const;

export interface RoomSnapshot {
  format: 1;
  values: Record<string, unknown>;
}

export function snapshotRoom(room: RoomState): RoomSnapshot {
  const values: Record<string, unknown> = {};
  values.pendingOpportunities = pendingOpportunitiesSchema.parse([...room.pendingOpportunities]);
  for (const key of scalarFields) values[key] = room[key];
  for (const key of mapFields) values[key] = [...room[key]];
  for (const key of nestedMapFields)
    values[key] = [...room[key]].map(([id, map]) => [id, [...map]]);
  for (const key of setFields) values[key] = [...room[key]];
  values.mobileMeleeTargets = [...room.mobileMeleeTargets].map(([id, targets]) => [
    id,
    [...targets],
  ]);
  const ready = room.readyCheck;
  values.readyCheck = ready
    ? readyCheckSchema.parse({
        id: ready.id,
        deadline: ready.deadline,
        playerIds: ready.playerIds,
        tokenIds: ready.tokenIds,
        responses: [...ready.responses],
      })
    : null;
  return JSON.parse(JSON.stringify({ format: 1, values })) as RoomSnapshot;
}

export function restoreRoom(room: RoomState, snapshot: RoomSnapshot): void {
  if (snapshot?.format !== 1 || !snapshot.values || typeof snapshot.values !== 'object') {
    throw new Error('Unsupported session runtime snapshot; refusing to reset saved game');
  }
  const values = snapshot.values;
  // Older format-1 snapshots predate durable ready checks. Never fabricate a
  // fresh deadline on hydration, and fail closed on malformed non-null checks.
  const ready = values.readyCheck == null ? null : readyCheckSchema.parse(values.readyCheck);
  // Production format-1 snapshots predate server-issued OA claims. Missing
  // claims stay empty; never mint a new claim or extend an existing deadline.
  const opportunities = pendingOpportunitiesSchema.parse(values.pendingOpportunities ?? []);
  const target = room as unknown as Record<string, unknown>;
  for (const key of scalarFields) {
    if (!(key in values)) throw new Error(`Missing session runtime field: ${key}`);
    target[key] = structuredClone(values[key]);
  }
  for (const key of [...mapFields, ...nestedMapFields, ...setFields, 'mobileMeleeTargets']) {
    if (!Array.isArray(values[key])) throw new Error(`Invalid session runtime field: ${key}`);
  }
  for (const key of mapFields)
    target[key] = new Map(structuredClone(values[key]) as [string, unknown][]);
  for (const key of nestedMapFields) {
    target[key] = new Map(
      (values[key] as [string, [string, unknown][]][]).map(([id, pairs]) => [id, new Map(pairs)])
    );
  }
  for (const key of setFields) target[key] = new Set(values[key] as string[]);
  room.pendingOpportunities = new Map(opportunities);
  room.mobileMeleeTargets = new Map(
    (values.mobileMeleeTargets as [string, string[]][]).map(([id, targets]) => [
      id,
      new Set(targets),
    ])
  );
  if (room.readyCheck?.timeout) clearTimeout(room.readyCheck.timeout);
  room.readyCheck = ready ? { ...ready, responses: new Map(ready.responses), timeout: null } : null;
  room.gameMode = room.combatState?.active ? 'combat' : 'free-roam';
}
