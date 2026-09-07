import { act, createContext, createElement, Fragment, StrictMode, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority } from 'react-reconciler/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Token } from '@dnd-vtt/shared';
import { TokenActionPanel } from './TokenActionPanel';
import { useMapStore } from '../../stores/useMapStore';
import { useCharacterStore } from '../../stores/useCharacterStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useCombatStore } from '../../stores/useCombatStore';
import { emitCharacterUpdate, emitSpellSlotAdjust, emitSystemMessage } from '../../socket/emitters';
import { broadcastCastAndAwaitCounterspell } from '../../socket/counterspellWindow';

vi.mock('../../socket/emitters');
vi.mock('../../socket/stateSnapshot');
vi.mock('../../socket/counterspellWindow');

// Use the installed React reconciler to mount the real panels and their effects
// without a browser or new DOM-test dependency. Only host rendering is a no-op.
const hostContext = {};
const noop = () => {};
let updatePriority = DefaultEventPriority;
const renderer = Reconciler({
  supportsMutation: true,
  isPrimaryRenderer: false,
  getRootHostContext: () => hostContext,
  getChildHostContext: () => hostContext,
  getPublicInstance: (instance: unknown) => instance,
  createInstance: () => ({}),
  createTextInstance: () => ({}),
  appendInitialChild: noop,
  appendChild: noop,
  appendChildToContainer: noop,
  insertBefore: noop,
  insertInContainerBefore: noop,
  removeChild: noop,
  removeChildFromContainer: noop,
  clearContainer: noop,
  prepareForCommit: () => null,
  resetAfterCommit: noop,
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  commitUpdate: noop,
  commitTextUpdate: noop,
  detachDeletedInstance: noop,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  setCurrentUpdatePriority: (priority: number) => {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () => updatePriority || DefaultEventPriority,
  shouldAttemptEagerTransition: () => false,
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null),
  resetFormInstance: noop,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
} as any);

const spell = {
  name: 'Magic Missile',
  level: 1,
  range: '120 feet',
  castingTime: '1 action',
  damage: '1d4+1',
};

function character(id: string, userId: string): Character {
  return {
    id,
    userId,
    name: id,
    class: 'Wizard',
    race: 'Human',
    level: 3,
    hitPoints: 20,
    maxHitPoints: 20,
    tempHitPoints: 0,
    armorClass: 12,
    speed: 30,
    abilityScores: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
    proficiencyBonus: 2,
    spellcastingAbility: 'int',
    spellSaveDC: 13,
    spellAttackBonus: 5,
    spellSlots: { 1: { max: 4, used: 0 } },
    spells: [],
    features: [],
    inventory: [],
    conditions: [],
  } as unknown as Character;
}

function token(id: string, x: number, ownerUserId: string | null): Token {
  return {
    id,
    characterId: id,
    mapId: 'map-1',
    name: id,
    x,
    y: 0,
    size: 1,
    imageUrl: null,
    ownerUserId,
    conditions: [],
    visible: true,
    layer: 'token',
    color: '#000',
    hasLight: false,
    lightRadius: 0,
    lightDimRadius: 0,
    lightColor: '#fff',
    createdAt: new Date(0).toISOString(),
  };
}

let root: ReturnType<typeof renderer.createContainer>;
let events: EventTarget;
let finishCasts: Array<(counterspelled: boolean) => void>;
let renderErrors: unknown[];
type PanelProps = NonNullable<Parameters<typeof TokenActionPanel>[0]>;

async function renderPanels(surfaces: Array<'canvas' | 'hero'>, strict = false) {
  const panels = createElement(
    Fragment,
    null,
    ...surfaces.map((surface) =>
      createElement<PanelProps>(TokenActionPanel, {
        key: surface,
        embedded: surface === 'hero',
        embeddedTokenId: surface === 'hero' ? 'hero' : undefined,
      })
    )
  );
  await render(strict ? createElement(StrictMode, null, panels) : panels);
}

async function render(node: ReactNode) {
  await act(async () => {
    renderer.updateContainer(node, root, null, noop);
  });
  expect(renderErrors).toEqual([]);
}

async function aimSpell() {
  await act(async () => {
    useMapStore.getState().startTargetingMode({
      spell: { ...spell },
      casterTokenId: 'hero',
      casterName: 'Hero',
    });
  });
}

async function clickTarget(tokenId = 'enemy') {
  await act(async () => {
    events.dispatchEvent(new CustomEvent('target-token-selected', { detail: { tokenId } }));
  });
}

async function finishPendingCasts(counterspelled = true) {
  await act(async () => {
    for (const finish of finishCasts.splice(0)) finish(counterspelled);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  events = new EventTarget();
  vi.stubGlobal('window', events);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  vi.spyOn(console, 'log').mockImplementation(noop);
  finishCasts = [];
  vi.mocked(broadcastCastAndAwaitCounterspell).mockImplementation(
    () => new Promise<boolean>((resolve) => finishCasts.push(resolve))
  );
  const hero = character('hero', 'user-1');
  useCharacterStore.setState({
    myCharacter: hero,
    allCharacters: { hero, enemy: character('enemy', 'npc') },
  });
  useSessionStore.setState({ userId: 'user-1', isDM: false, dmIgnoreSpellSlots: false });
  useCombatStore.setState({ active: false, combatants: [], currentTurnIndex: 0 });
  useMapStore.setState({
    currentMap: { id: 'map-1', gridSize: 70 } as any,
    tokens: { hero: token('hero', 0, 'user-1'), enemy: token('enemy', 70, null) },
    selectedTokenId: 'hero',
    selectedTokenIds: ['hero'],
    isTargeting: false,
    targetingData: null,
    isDmPreviewingDifferentMap: false,
  });
  renderErrors = [];
  const onError = (error: unknown) => {
    renderErrors.push(error);
  };
  root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    false,
    null,
    '',
    onError,
    onError,
    onError,
    noop
  );
});

afterEach(async () => {
  await finishPendingCasts();
  await render(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mounted canvas + Hero targeting', () => {
  it.each([
    ['canvas', 'hero'],
    ['hero', 'canvas'],
  ] as const)('casts once with %s mounted before %s', async (first, second) => {
    await renderPanels([first, second]);
    await aimSpell();
    await clickTarget();

    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
    expect(emitSpellSlotAdjust).toHaveBeenCalledTimes(1);
    expect(finishCasts).toHaveLength(1);
  });

  it('ignores repeated target clicks while a cast is resolving', async () => {
    await renderPanels(['canvas', 'hero']);
    await aimSpell();
    await clickTarget();
    await clickTarget();

    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
    await finishPendingCasts();
    await aimSpell();
    await clickTarget();
    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(2);
  });

  it('keeps the flight locked when its panel unmounts and the other surface remains', async () => {
    await renderPanels(['hero', 'canvas']);
    await aimSpell();
    await clickTarget();
    await renderPanels(['canvas']);
    await clickTarget();

    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
    await finishPendingCasts();
    await aimSpell();
    await clickTarget();
    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate handlers through Strict Mode effect remounts', async () => {
    await aimSpell();
    await renderPanels(['canvas', 'hero'], true);
    await clickTarget();
    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
  });

  it.each(['canvas', 'hero'] as const)(
    'still completes a cast with only the %s surface mounted',
    async (surface) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      await renderPanels([surface]);
      await aimSpell();
      await clickTarget();
      await finishPendingCasts(false);

      expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
      expect(emitCharacterUpdate).toHaveBeenCalledExactlyOnceWith('enemy', { hitPoints: 16 });
      expect(emitSystemMessage).toHaveBeenCalledTimes(1);
      expect(useCharacterStore.getState().allCharacters.enemy.hitPoints).toBe(16);
      expect(useMapStore.getState().isTargeting).toBe(false);
    }
  );

  it('keeps Hero targeting usable when the floating canvas panel is hidden', async () => {
    await renderPanels(['canvas', 'hero']);
    await act(async () => {
      useMapStore.getState().selectToken(null);
    });
    await aimSpell();
    await clickTarget();
    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
  });

  it('allows a valid target after ignoring an unknown token', async () => {
    await renderPanels(['canvas', 'hero']);
    await aimSpell();
    await clickTarget('missing-token');
    expect(broadcastCastAndAwaitCounterspell).not.toHaveBeenCalled();
    expect(useMapStore.getState().isTargeting).toBe(true);
    await clickTarget();
    expect(broadcastCastAndAwaitCounterspell).toHaveBeenCalledTimes(1);
  });

  it('preserves Escape cancellation before a target is chosen', async () => {
    await renderPanels(['canvas', 'hero']);
    await aimSpell();
    await act(async () => {
      events.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    });
    await clickTarget();
    expect(useMapStore.getState().isTargeting).toBe(false);
    expect(broadcastCastAndAwaitCounterspell).not.toHaveBeenCalled();
  });
});
