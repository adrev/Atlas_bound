# Combat Foundation + Condition Rules Engine

This is a multi-sprint plan to bring the VTT from "spell badges + chat math"
to "real D&D 5e combat with enforced rules."

## The two halves

1. **Combat Foundation** — Initiative roll flow, turn order UI, End Turn
   button, round counter, action economy, auto-skip dead. Already 60%
   built (see `useCombatStore`, `combatEvents.ts`, `InitiativeTracker`),
   needs UI polish and a few missing flows.

2. **Condition Rules Engine** — A central rules system that reads each
   token's conditions/buffs and applies the mechanical effects to every
   roll, AC, speed, damage, and visibility check. 5 phases.

Both ship together because Phase 5 (duration tracking) depends on the
combat round counter to decrement turns.

---

## Sprint 1 — Combat Foundation

### 1.1 Initiative roll flow (½ day)
Already partially built. Verify and complete:
- DM clicks "Start Combat" → server picks all tokens on the map as combatants
- For each NPC: auto-roll d20 + DEX mod (or initiative bonus from monster stat block)
- For each player-owned token: emit `combat:initiative-prompt` to that player's socket
- Players see a small "Roll Initiative" toast on their screen → click → roll
- Once all initiatives are in, server sorts and emits `combat:all-initiatives-ready`
- Initiative tracker UI populates with the sorted order

**What's missing:**
- The initiative-prompt toast on the player side
- Verifying NPC auto-roll uses the right ability (DEX mod, not just d20)
- Tie-breaker logic (higher DEX wins, then random)

### 1.2 End Turn button (already exists, just needs testing)
- `InitiativeTracker.tsx` has it
- Clicking emits `combat:next-turn`
- Server advances `currentTurnIndex`, broadcasts `combat:turn-advanced`
- Auto-skips dead/unconscious combatants
- When index loops back to 0, increment `roundNumber`

### 1.3 Action economy display (½ day)
Each combatant has:
- Action: used / available
- Bonus action: used / available
- Reaction: used / available
- Movement: used / max (in feet)

Reset on turn start. Display in the action economy bar at the bottom of
the InitiativeTracker. Only the current turn's combatant shows their
economy; everyone else just sees the strip.

Tracking is mostly server-side via `combat:action-used` events. Need to
verify the existing flow works and the UI updates.

### 1.4 Auto-skip dead/down combatants
When `currentTurnIndex` advances, if the new combatant has HP ≤ 0,
auto-advance again. Loop until we find a live one. Already partially
wired via `nextTurn` action — verify it works.

### 1.5 Round counter prominence
Already shown in the InitiativeTracker header. Just verify it
increments correctly on round wraparound.

---

## Sprint 2 — Phase 1: Roll Modifier Engine

### Architecture

New shared module `client/src/utils/roll-engine.ts`:

```typescript
interface RollContext {
  // Advantage / disadvantage flags
  attackAdvantage: 'advantage' | 'disadvantage' | 'normal';
  saveAdvantage: Partial<Record<AbilityName, 'advantage' | 'disadvantage' | 'normal'>>;
  abilityCheckAdvantage: Partial<Record<AbilityName, 'advantage' | 'disadvantage' | 'normal'>>;

  // Bonus dice (Bless +1d4, Bane -1d4, Bardic Inspiration etc.)
  attackBonusDice: string;        // '+1d4' or ''
  saveBonusDice: string;          // '+1d4' or ''

  // Auto-fail / auto-succeed
  autoFailSaves: AbilityName[];   // Paralyzed, Stunned, Unconscious → STR, DEX
  autoSucceedSaves: AbilityName[];

  // Crit triggers
  forceCritOnMeleeWithin5ft: boolean; // Paralyzed, Unconscious

  // Notes for chat output
  notes: string[];                // ["Bless +1d4", "Poisoned (disadvantage)"]
}

function getRollContext(token: Token, character: Character): RollContext;
```

### Hook into the cast resolver
Current code:
```typescript
const aSaveRoll = Math.floor(Math.random() * 20) + 1;
const aSaveTotal = aSaveRoll + aSaveMod;
```

After Phase 1:
```typescript
const ctx = getRollContext(targetToken, targetChar);
const { roll, total, breakdown } = rollWithModifiers({
  type: 'save',
  ability: 'wis',
  baseMod: aSaveMod,
  context: ctx,
});
```

`rollWithModifiers` handles:
- Roll one d20 OR two d20s (advantage/disadvantage), keep highest/lowest
- Add base mod
- Add Bless's `+1d4` if `ctx.saveBonusDice` is set
- Auto-fail returns `total = -999` if applicable
- Returns breakdown for chat: `"d20=16 +5 +1d4(3) = 24 with advantage"`

### Conditions wired in Phase 1

| Condition | Effect |
|---|---|
| **Blessed** | +1d4 to attack rolls AND saving throws |
| **Baned** | -1d4 to attack rolls AND saving throws |
| **Hex** (chosen ability) | Disadvantage on chosen ability checks (skipped — needs picker) |
| **Poisoned** | Disadvantage on attack rolls AND ability checks |
| **Frightened** | Disadvantage on ability checks AND attack rolls (when source visible — we ignore the visibility check for now) |
| **Restrained** | Disadvantage on attack rolls AND DEX saves; advantage to attackers |
| **Prone** | Disadvantage on attack rolls; advantage to melee attackers within 5 ft; disadvantage to ranged attackers |
| **Blinded** | Disadvantage on attack rolls; advantage to attackers |
| **Invisible attacker** | Advantage on attack rolls; disadvantage to attackers (when target can't see) |
| **Paralyzed** | Auto-fail STR & DEX saves; advantage to attackers; melee within 5 ft auto-crit |
| **Stunned** | Auto-fail STR & DEX saves; advantage to attackers |
| **Unconscious** | Auto-fail STR & DEX saves; advantage to attackers; melee within 5 ft auto-crit |
| **Petrified** | Advantage to attackers |
| **Hasted** | Advantage on DEX saves |
| **Slowed** | -2 to DEX saves (handled in Phase 2 as save bonus) |

### Chat output

Spell results add a "modifiers" line per target:
```
✦ Liraya casts Hold Person → Bandit
   Spent level 2 slot
   • Bandit: ✗ WIS 8 vs DC 13 → FAILED [Bless +3]  • now paralyzed
```

The breakdown shows the actual dice involved.

---

## Sprint 3 — Phase 2: AC + Speed Modifiers

### Architecture

New helpers in the same `roll-engine.ts`:

```typescript
function effectiveAC(token: Token, character: Character): number;
function effectiveSpeed(token: Token, character: Character): number;
```

### AC modifiers

| Source | Effect |
|---|---|
| **Hasted** | +2 AC |
| **Slowed** | -2 AC |
| **Shield of Faith** | +2 AC |
| **Mage Armor** | AC = max(currentAC, 13 + DEX mod) — only when not wearing armor |
| **Shield (spell)** | +5 AC until next turn (reaction — phase 6 feature) |
| **Barkskin** | AC = max(currentAC, 16) |
| **Stoneskin** | (no AC change, but resistance — Phase 3) |
| **Defensive Duelist** | +PB AC vs one attack (reaction) |

The character sheet's AC value stays as the base; the cast resolver uses
`effectiveAC()` to get the value for hit checks.

### Speed modifiers

| Source | Effect |
|---|---|
| **Hasted** | × 2 |
| **Slowed** | × 0.5 (half) |
| **Grappled** | = 0 |
| **Restrained** | = 0 |
| **Paralyzed** | = 0 |
| **Stunned** | = 0 |
| **Unconscious** | = 0 |
| **Petrified** | = 0 |
| **Prone** | half movement to stand (handled by movement counter) |

When we wire movement enforcement (later sprint), `effectiveSpeed()` is
the source of truth.

### Display

Token info panel shows AC and Speed with the EFFECTIVE values, with a
small `(base 14, +2 Hasted)` tooltip when modified. Same in the
character sheet header.

---

## Sprint 4 — Phase 3: Damage Resistance / Immunity / Vulnerability

### Architecture

```typescript
interface DamageResult {
  amount: number;       // final amount applied
  multiplier: number;   // 0 immune, 0.5 resistant, 1 normal, 2 vulnerable
  source: string;       // "Stoneskin (resistance)" / "Fire immunity" / etc.
}

function applyDamageWithResist(
  token: Token,
  character: Character,
  baseAmount: number,
  damageType: string,
): DamageResult;
```

### Sources of resistance/immunity/vulnerability

1. **Character racial / class**: read from `character.defenses.{resistances, immunities, vulnerabilities}` arrays (DDB import populates these)
2. **Active conditions**:
   - **Stoneskin** → resistance to nonmagical bludgeoning, piercing, slashing
   - **Petrified** → resistance to all damage
   - **Death Ward** → not actually resistance, prevents one death (Phase 6)
3. **Magical items**: from `character.inventory[i].properties` — future work

### Hook into damage application

Current code:
```typescript
const newHp = Math.max(0, freshHp - finalDmg);
```

After Phase 3:
```typescript
const result = applyDamageWithResist(targetToken, targetChar, finalDmg, dmgType);
const newHp = Math.max(0, freshHp - result.amount);
// Add result.source to chat: "12 fire dmg → 6 (Stoneskin: resist B/P/S)"
```

Chat shows the multiplier: `12 → 6 (resisted)`, `12 → 24 (vulnerable)`, `12 → 0 (immune)`.

---

## Sprint 5 — Phase 4: Visibility / Invisible Enforcement

### Token visibility rules

Each token has implicit "side" (player vs DM). For each viewer, compute:
- Same side: see all ally tokens, regardless of conditions
- Opposing side: see only tokens that are visible to the viewer
- DM: see all tokens (with "hidden" ones rendered at low opacity)

A token is "visible to the opposing side" if:
- Not invisible (no Invisible / Greater Invisibility condition)
- Not benefiting from Pass without Trace
- Not in fog of war (already enforced)

### Implementation

`TokenLayer.tsx` already filters tokens by `visible` flag and fog of war.
Add a condition check before the existing filter:

```typescript
const visibleToMe = (token: Token): boolean => {
  if (isDM) return true;  // DM sees everything
  if (!token.visible) return false;
  // Same-side tokens always visible
  if (token.ownerUserId === userId) return true;
  // Opposing side: check invisibility conditions
  const conditions = token.conditions || [];
  if (conditions.includes('invisible')) return false;
  return true;
};
```

### Caveats

- DM can still see invisible tokens (slightly dimmed) so they can move them
- Faerie Fire cancels invisibility (target gets `outlined` instead) — future
- See Invisibility spell — future

---

## Sprint 6 — Phase 5: Duration Tracking + Save Retries

### Migration

Today: `token.conditions: string[]` (just badges)

After Phase 5: `token.conditions: ConditionInstance[]` where:

```typescript
interface ConditionInstance {
  name: string;                          // 'paralyzed' / 'blessed' / etc.
  source: string;                        // 'Hold Person' / 'manual' / 'Bless'
  casterId?: string;                     // who cast it (for concentration cleanup)
  expiresAfterRound?: number;            // combat round number after which it auto-expires
  expiresOnTurnEnd?: string;             // tokenId whose turn-end clears it
  saveAtEndOfTurn?: { ability: AbilityName; dc: number; advantage?: boolean };
}
```

### Backward compatibility

`token.conditions` field is read in many places. To avoid breaking
everything, I'll do a SOFT migration:
- New write path uses `ConditionInstance[]`
- Read path supports both: if it's a string, treat as `{ name: string, source: 'manual' }`
- Helper `extractConditionNames(conditions)` returns `string[]` for the existing display code

### Duration sources

| Spell | Duration |
|---|---|
| Bless | 1 minute (10 rounds) |
| Hold Person | 1 minute, save at end of each turn |
| Sleep | 1 minute, ends on damage |
| Hideous Laughter | 1 minute, save each turn AND on damage with advantage |
| Faerie Fire | 1 minute |
| Charm Person | 1 hour (essentially infinite for combat) |
| Fear | 1 minute, save each turn |
| Hypnotic Pattern | 1 minute, save on damage |

### On turn end

```typescript
function tickConditions(tokenId: string, currentRound: number) {
  const token = ...;
  const newConditions = token.conditions.filter(cond => {
    // Auto-expire
    if (cond.expiresAfterRound && currentRound > cond.expiresAfterRound) return false;

    // Save-at-end-of-turn (Hold Person etc.)
    if (cond.saveAtEndOfTurn) {
      const { ability, dc, advantage } = cond.saveAtEndOfTurn;
      const result = rollSave(token, ability, dc, advantage);
      if (result.success) {
        emitSystemMessage(`${tokenName} saves vs ${cond.source}, ending the effect`);
        return false;
      }
    }
    return true;
  });
  if (newConditions.length !== token.conditions.length) {
    emitTokenUpdate(tokenId, { conditions: newConditions });
  }
}
```

Called from the server's `combat:next-turn` handler, on every advance,
for the token whose turn just ended.

### On damage taken

For conditions like Sleep (ends on damage) and Hideous Laughter (save with advantage on damage):
- Hook into the damage application path
- After damage, check for `endsOnDamage` or `saveOnDamageWithAdvantage` flags
- Roll the save or auto-clear

### On concentration drop

When `concentratingOn` is cleared on the caster:
- Find every token whose conditions array has an entry with `casterId === thisCaster`
- Remove those entries
- Emit a chat note: `"Bless drops as Liraya loses concentration"`

---

## Build order

Sprint 1 first because it's the foundation. Then Sprints 2-4 can ship in
any order since they don't depend on each other. Sprint 5 (visibility) is
also independent. Sprint 6 (duration) requires Sprint 1.

I'll commit each sprint independently so each is shippable. The user can
test after every sprint.

## Estimated complexity

- Sprint 1: ½-1 day (mostly UI polish on existing infrastructure)
- Sprint 2: 1 day (real new architecture, lots of conditions)
- Sprint 3: ½ day (small surface area)
- Sprint 4: ½ day (resistance map + chat output)
- Sprint 5: ½ day (one filter)
- Sprint 6: 1-2 days (the big one — migration + duration loop + concentration cleanup)

Total: 4-5 days of focused work. Will commit at every milestone.
