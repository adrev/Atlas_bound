# 5e Rules Matrix

This project targets 2014 D&D 5e style play for v1. The matrix below is the
working contract for what KBRT automates, what it only helps the DM run, and
what is intentionally out of scope for now.

Use this document with `shared/src/rules5e/rulesMatrix.ts`. The TypeScript file
is the machine-readable source for product/UI/test classification. This Markdown
file is the human summary for PM and implementation planning.

## Classification

- `core-5e`: should match 2014 5e/SRD behavior.
- `variant`: optional rule or table preference. It must be session-setting gated.
- `house-rule`: deliberate KBRT-specific behavior. It must be labeled in UI and tests.
- `manual-helper`: chat/UI convenience only. It may roll or announce, but it is not authoritative automation.
- `ui-preview`: client-only display. It must not mutate authoritative state.
- `unsupported`: visible in character or compendium data, but not automated yet.

## Authority Model

The target architecture is server-authoritative mechanics with client preview:

- The server owns HP, death saves, concentration, conditions, action economy, resources, movement spend, and spell/attack resolution.
- The client owns target selection, previews, animation, and display.
- Chat commands either call the same server resolver or are explicitly labeled `manual-helper`.
- DM overrides are allowed, but they should produce clear audit/chat output.

## Current Priority Matrix

| Area | Mode | Status | Priority | Notes |
| --- | --- | --- | --- | --- |
| Server action authority | `core-5e` | partial | P0 | `TokenActionPanel` still resolves many attacks/spells and writes HP/resources from the client. |
| Death saves and stabilization | `core-5e` | implemented | P1 | 3 successes make the creature stable at 0 HP and still unconscious. Nat 20 heals 1 HP. Non-DMs can roll only on their death-save turn and once per round. |
| Healing downed characters | `core-5e` | implemented | P1 | Healing above 0 HP clears stable/unconscious state and syncs token/combatant/character state. |
| Movement diagonals | `core-5e` | partial | P1 | Default grid behavior should count a diagonal square as one square unless a variant setting is added. |
| Opportunity attacks | `core-5e` | partial | P1 | Movement OAs are core. Spellcasting OAs are not core and are disabled by default. |
| Damage pipeline | `core-5e` | partial | P1 | All damage should flow through the same server path for temp HP, death saves, concentration, and visibility-scoped broadcasts. |
| Save modifiers | `core-5e` | partial | P1 | Slow and cover require flat save modifiers, not only advantage/disadvantage. |
| Spell AoE commands | `manual-helper` -> `core-5e` | inconsistent | P1 | Some commands apply HP, some only render cards. Normalize through the server resolver. |
| Grapple and shove | `core-5e` | partial | P2 | Needs size, reach, free-hand, action-cost, and incapacitated-target handling. |
| Hide and stealth | `manual-helper` | partial | P2 | Useful helper, but not rules-complete until it uses line of sight, lighting, cover, and active searching. |
| Equipment and armor | `core-5e` | partial | P2 | AC and manual heavy armor speed penalties are covered; stealth disadvantage is still only data until stealth is more automated. |
| Rests and resources | `core-5e` | partial | P2 | DM `!rest`, player rest buttons, manual Hit Dice spending, and spell-slot spend/refund counters are server-owned; broader feature/resource spend flows still need cleanup. |
| Race, class, feat features | mixed | partial | P2 | Many are notes or chat macros. Each needs automation or explicit manual-helper labeling. |
| Monsters and compendium actions | `core-5e` | partial | P3 | Raw stat-block prose is useful for browsing but not enough for automated combat. |

## First Implementation Slice

1. Add this matrix and the machine-readable rules matrix.
2. Fix death-save stabilization and healing/unconscious cleanup.
3. Make movement diagonal math consistent.
4. Keep spellcasting opportunity attacks out of the default flow unless a session-level house-rule toggle is added.
5. Start extracting a server rules resolver in small spell/action families.
