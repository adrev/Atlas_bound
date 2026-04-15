import { useEffect, useRef } from 'react';
import { useDiceAnimationStore } from '../../stores/useDiceAnimationStore';
import { emitPhysicalRoll } from '../../socket/emitters';

/**
 * 3D dice roll animation using @3d-dice/dice-box.
 *
 * Flow:
 *   1. Dice Tray button or `/r` chat command calls
 *      `useDiceAnimationStore.playPhysical(notation, reason, hidden)`.
 *   2. This component picks up the queued entry, feeds the notation to
 *      dice-box, and waits for the `onRollComplete` callback.
 *   3. On settle it reads the actual dice values dice-box landed on
 *      and emits `chat:roll` with `reported: { dice, total }`. The
 *      server trusts those numbers and broadcasts the chat card.
 *   4. After a short hold it clears the scene so the next roll starts
 *      fresh.
 *
 * Non-physical rolls (attacks, spells, initiative) skip this path
 * entirely and go straight through `emitRoll` → server random.
 */

const DICE_BOX_CONTAINER_ID = 'dnd-vtt-dice-box';

// Module-level singleton. StrictMode, HMR, and the twin AppShell
// mobile/desktop render paths all risk creating the overlay component
// more than once; when that happens a second `new DiceBox()` call
// loads Babylon.js + Ammo a second time and the two instances fight
// for the canvas (the "click doesn't start" bug). Singleton ensures
// one box per page regardless of how many overlays mount.
let diceBoxSingleton: DiceBoxInstance | null = null;
let diceBoxSingletonInit: Promise<DiceBoxInstance> | null = null;

interface DiceBoxDieResult {
  sides: number | string;
  value: number;
  rollId?: string;
  groupId?: number;
}

interface DiceBoxOptions {
  container?: string | HTMLElement;
  assetPath: string;
  theme?: string;
  scale?: number;
  gravity?: number;
  mass?: number;
  friction?: number;
  restitution?: number;
  angularDamping?: number;
  linearDamping?: number;
}

interface DiceBoxInstance {
  init: () => Promise<unknown>;
  clear: () => void;
  roll: (notation: string) => Promise<DiceBoxDieResult[]>;
  resize: () => void;
  onRollComplete?: (results: DiceBoxDieResult[]) => void;
}

export function Dice3DOverlay() {
  const active = useDiceAnimationStore((s) => s.active);
  const completeAnim = useDiceAnimationStore((s) => s.complete);
  const list = Array.isArray(active) ? active : [];

  const boxRef = useRef<DiceBoxInstance | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const processedIdsRef = useRef<Set<number>>(new Set());
  // Serialisation lock — at most one roll animating at a time. Prevents
  // a second click from calling box.clear() mid-physics (the "dice
  // disappear" bug) or the useEffect from re-entering with stale state
  // (the "click doesn't start" bug).
  const workerRef = useRef<Promise<void> | null>(null);

  // Lazy-init dice-box on first roll. Guarded against double-init —
  // React StrictMode runs effects twice in dev and our AppShell
  // remounts on layout changes, so the promise-ref alone isn't enough
  // of a gate. The module-level `diceBoxSingleton` below ensures we
  // only ever create ONE dice-box instance per page.
  useEffect(() => {
    if (list.length === 0) return;
    if (boxRef.current) return;
    if (diceBoxSingleton) {
      // Another instance of the overlay already booted dice-box —
      // reuse it.
      boxRef.current = diceBoxSingleton;
      return;
    }
    if (initPromiseRef.current) return;
    if (!diceBoxSingletonInit) {
      diceBoxSingletonInit = (async () => {
        const { default: DiceBox } = await import('@3d-dice/dice-box');
        const container = document.getElementById(DICE_BOX_CONTAINER_ID);
        if (!container) throw new Error('dice-box container missing');
        const start = performance.now();
        while (container.offsetWidth === 0 || container.offsetHeight === 0) {
          if (performance.now() - start > 1000) break;
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
        const options: DiceBoxOptions = {
          container: `#${DICE_BOX_CONTAINER_ID}`,
          assetPath: '/assets/dice-box/',
          theme: 'default',
          scale: 6,
          gravity: 1.4,
          mass: 1,
          friction: 0.8,
          restitution: 0.1,
          angularDamping: 0.3,
          linearDamping: 0.4,
        };
        const BoxCtor = DiceBox as unknown as new (o: DiceBoxOptions) => DiceBoxInstance;
        const box = new BoxCtor(options);
        await box.init();
        if (typeof box.resize === 'function') box.resize();
        diceBoxSingleton = box;
        return box;
      })();
    }
    initPromiseRef.current = diceBoxSingletonInit.then((box) => {
      boxRef.current = box;
    });
  }, [list.length]);

  useEffect(() => {
    const onResize = () => {
      const box = boxRef.current;
      if (box && typeof box.resize === 'function') box.resize();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Start (or restart) the worker when the queue has unprocessed
  // entries. The worker runs to completion even if the `list` prop
  // changes mid-loop — it re-reads the store each iteration — so new
  // clicks during an in-flight roll queue behind cleanly.
  useEffect(() => {
    if (list.length === 0) return;
    const unprocessed = list.some((a) => !processedIdsRef.current.has(a.id));
    if (!unprocessed) return;
    if (workerRef.current) return;

    workerRef.current = (async () => {
      try {
        // Loop until the store has no fresh entries to process. We
        // pull from the store directly (not the captured `list` prop)
        // so entries added mid-roll are picked up.
        while (true) {
          if (initPromiseRef.current) await initPromiseRef.current;
          const box = boxRef.current;
          if (!box) break;

          const state = useDiceAnimationStore.getState().active;
          const next = state.find((a) => !processedIdsRef.current.has(a.id));
          if (!next) break;
          processedIdsRef.current.add(next.id);

          box.clear();
          try {
            const results = await box.roll(next.notation);
            // `sides` may come back as 'd20' or 20 — normalise.
            const dice = (Array.isArray(results) ? results : []).map((r) => ({
              type: typeof r.sides === 'number'
                ? r.sides
                : parseInt(String(r.sides).replace(/[^0-9]/g, ''), 10) || 0,
              value: r.value,
            })).filter((d) => d.type > 0);

            const diceSum = dice.reduce((s, d) => s + d.value, 0);
            const modifier = parseNotationModifier(next.notation);
            const total = diceSum + modifier;

            emitPhysicalRoll(next.notation, next.reason, next.hidden, dice, total);
          } catch (err) {
            console.warn('[dice-box] physical roll failed', err);
            emitPhysicalRoll(next.notation, next.reason, next.hidden, [], 0);
          }

          // Hold on the landed face. Only clear the box IF there's no
          // follow-up roll queued — otherwise the next iteration will
          // clear-then-roll itself and we avoid a visible blank frame.
          await new Promise<void>((r) => window.setTimeout(r, 1800));
          const followUp = useDiceAnimationStore
            .getState().active
            .some((a) => !processedIdsRef.current.has(a.id));
          if (!followUp) box.clear();
          completeAnim(next.id);
        }
      } finally {
        workerRef.current = null;
      }
    })();
  }, [list, completeAnim]);

  const visible = list.length > 0;

  return (
    <>
      {/* Pin whatever canvas dice-box injects to the container. */}
      <style>{`#${DICE_BOX_CONTAINER_ID} canvas { width: 100% !important; height: 100% !important; display: block !important; }`}</style>
      <div
        id={DICE_BOX_CONTAINER_ID}
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: 9999,
          opacity: visible ? 1 : 0,
          transition: 'opacity 300ms ease-out',
        }}
      />
    </>
  );
}

/**
 * Pull a bare +N or -N modifier off the end of a dice notation.
 * Anything more exotic (keep-highest, reroll, etc.) returns 0 and the
 * caller just uses the dice sum as-is.
 */
function parseNotationModifier(notation: string): number {
  const m = notation.match(/([+-]\s*\d+)\s*$/);
  if (!m) return 0;
  return parseInt(m[1].replace(/\s/g, ''), 10) || 0;
}
