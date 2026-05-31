export const RULE_MODES = [
  'core-5e',
  'variant',
  'house-rule',
  'manual-helper',
  'ui-preview',
  'unsupported',
] as const;

export type RuleMode = typeof RULE_MODES[number];

export type RuleCategory =
  | 'architecture'
  | 'combat'
  | 'action'
  | 'spell'
  | 'condition'
  | 'equipment'
  | 'resource'
  | 'monster'
  | 'content';

export type RuleCoverageStatus =
  | 'implemented'
  | 'partial'
  | 'inconsistent'
  | 'planned'
  | 'unsupported';

export type RuleAuthority =
  | 'server'
  | 'client'
  | 'shared'
  | 'chat-command'
  | 'manual'
  | 'mixed';

export type RulePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface RulesMatrixEntry {
  id: string;
  label: string;
  category: RuleCategory;
  mode: RuleMode;
  status: RuleCoverageStatus;
  authority: RuleAuthority;
  priority: RulePriority;
  paths: string[];
  notes: string[];
  nextSteps: string[];
}

export const RULES_MATRIX_VERSION = '2026-05-30-rules-v1';

export const RULES_MATRIX: RulesMatrixEntry[] = [
  {
    id: 'rules.server-authority',
    label: 'Server-authoritative action resolution',
    category: 'architecture',
    mode: 'core-5e',
    status: 'partial',
    authority: 'mixed',
    priority: 'P0',
    paths: [
      'client/src/components/canvas/TokenActionPanel.tsx',
      'server/src/socket/combat/reactionEvents.ts',
      'server/src/services/CombatService.ts',
    ],
    notes: [
      'Many attack, spell, resource, HP, and condition changes are still resolved client-side.',
      'The target architecture is server resolution with client preview and animation.',
    ],
    nextSteps: [
      'Introduce server-side resolveAction for one spell/action family at a time.',
      'Classify existing chat commands as authoritative or manual-helper.',
    ],
  },
  {
    id: 'combat.death-saves',
    label: 'Death saves and stabilization',
    category: 'combat',
    mode: 'core-5e',
    status: 'implemented',
    authority: 'server',
    priority: 'P1',
    paths: [
      'server/src/socket/combat/hpEvents.ts',
      'server/src/services/CombatService.ts',
    ],
    notes: [
      'A creature with three death-save successes is stable at 0 HP and remains unconscious.',
      'A natural 20 heals 1 HP and should clear unconscious/stable state.',
      'Non-DM death saves require the token to be at 0 HP, in active combat, on its own turn, not stable, and not already rolled this round.',
    ],
    nextSteps: [
      'Keep regression coverage as combat state expands.',
    ],
  },
  {
    id: 'combat.healing-downed',
    label: 'Healing downed characters',
    category: 'combat',
    mode: 'core-5e',
    status: 'implemented',
    authority: 'server',
    priority: 'P1',
    paths: ['server/src/services/CombatService.ts', 'server/src/socket/combat/hpEvents.ts'],
    notes: ['Healing above 0 HP clears death saves plus stable/unconscious state and broadcasts the resulting token condition patch.'],
    nextSteps: ['Keep healing routed through server-owned HP actions as more item/spell healers are automated.'],
  },
  {
    id: 'combat.movement-distance',
    label: 'Grid movement distance',
    category: 'combat',
    mode: 'core-5e',
    status: 'partial',
    authority: 'mixed',
    priority: 'P1',
    paths: [
      'shared/src/utils/grid-math.ts',
      'server/src/socket/tokenEvents.ts',
      'client/src/hooks/useDragToken.ts',
      'client/src/components/canvas/layers/MovementRangeLayer.tsx',
    ],
    notes: [
      'The default grid rule treats a diagonal square as one square.',
      'Active-combat token movement is validated and spent server-side for the current combatant.',
      'Optional diagonal variants should be session settings rather than hidden mismatches.',
    ],
    nextSteps: ['Keep range preview, drag display, and server validation on the shared grid-distance helper.'],
  },
  {
    id: 'combat.opportunity-attacks',
    label: 'Opportunity attacks',
    category: 'combat',
    mode: 'core-5e',
    status: 'partial',
    authority: 'server',
    priority: 'P1',
    paths: [
      'server/src/services/OpportunityAttackService.ts',
      'server/src/socket/combat/reactionEvents.ts',
    ],
    notes: [
      'Movement opportunity attacks are core 5e.',
      'Spellcasting opportunity attacks are not core 5e and are disabled in the default socket flow.',
      'OA damage should share the normal damage pipeline.',
    ],
    nextSteps: ['If desired later, re-add spellcasting OAs behind an explicit house-rule session toggle.'],
  },
  {
    id: 'condition.save-modifiers',
    label: 'Condition and cover save modifiers',
    category: 'condition',
    mode: 'core-5e',
    status: 'partial',
    authority: 'mixed',
    priority: 'P1',
    paths: [
      'shared/src/rules/conditionEffects.ts',
      'server/src/services/chatCommands/saveRoll.ts',
      'server/src/services/chatCommands/saveHandler.ts',
      'server/src/services/chatCommands/subclassFeaturesHandler.ts',
      'server/src/services/chatCommands/subclassFeaturesTier11Handler.ts',
      'server/src/services/chatCommands/subclassFeaturesTier13Handler.ts',
      'server/src/services/chatCommands/monkHandler.ts',
      'server/src/services/chatCommands/miscClassHandlers.ts',
      'server/src/services/chatCommands/hazardsHandler.ts',
      'client/src/utils/roll-engine.ts',
    ],
    notes: [
      'Slow and cover flat save modifiers are modeled in shared rules and applied by the server save resolver plus client roll engine.',
      'Race save traits are read from raceFeatures.savesVs; damage resistances remain defense math rather than save advantage.',
      'Save labels can include overlapping categories so magical charm effects can trigger both gnome magic and elf charm traits.',
      'Base subclass Wrath of the Storm and Fey Presence saves route through the shared save helper.',
      'Tier 11 Open Hand, Strength of the Grave, and Enthralling Performance saves route through the shared save helper.',
      'Tier 13 Channel Divinity feature saves route through the shared save helper.',
      'Monk Stunning Strike routes its CON save through the shared save helper.',
      'Dragonborn Breath Weapon and Battle Master save maneuvers route through the shared save helper.',
      'Disease and poison hazard saves route through the shared save helper.',
    ],
    nextSteps: ['Continue routing remaining individual spell and feature chat-command save helpers through the shared resolver so every save path gets the same modifier math.'],
  },
  {
    id: 'spell.aoe-consistency',
    label: 'Area spell and save command consistency',
    category: 'spell',
    mode: 'core-5e',
    status: 'inconsistent',
    authority: 'mixed',
    priority: 'P1',
    paths: [
      'client/src/components/canvas/TokenActionPanel.tsx',
      'server/src/services/chatCommands/saveHandler.ts',
      'server/src/services/chatCommands/spellsTier12Handler.ts',
      'server/src/services/chatCommands/spellsTier16Handler.ts',
      'server/src/services/chatCommands/spellsTier21Handler.ts',
    ],
    notes: [
      'Tier 12 save helpers use shared save modifier math for condition/race advantage, auto-fail, and flat save modifiers.',
      'Tier 16 save helpers use shared save modifier math for condition advantage, auto-fail, and flat save modifiers.',
      'Tier 21 save helpers use shared save modifier math for condition/race advantage, auto-fail, and flat save modifiers.',
      'Tier 21 Feeblemind now rolls 4d6 psychic and applies the feebleminded pseudo-condition; Power Word Stun end saves are CON.',
      'Different spell paths still roll damage, apply defenses, and mutate HP differently.',
    ],
    nextSteps: ['Continue routing one spell tier/family at a time through the shared server save/damage resolver.'],
  },
  {
    id: 'action.grapple-shove',
    label: 'Grapple and shove',
    category: 'action',
    mode: 'core-5e',
    status: 'partial',
    authority: 'chat-command',
    priority: 'P2',
    paths: ['server/src/services/chatCommands/maneuverHandlers.ts'],
    notes: ['Opposed checks, reach, the one-size-larger target limit, caller incapacitation, grapple free-hand checks, and in-combat Action cost are enforced.'],
    nextSteps: ['Keep labeled partial until push-direction automation and richer hand/equipment state are modeled.'],
  },
  {
    id: 'action.hide-stealth',
    label: 'Hide and stealth',
    category: 'action',
    mode: 'manual-helper',
    status: 'partial',
    authority: 'chat-command',
    priority: 'P2',
    paths: ['server/src/services/chatCommands/stealthHandler.ts'],
    notes: ['Current helper compares passive perception and applies armor-imposed Stealth disadvantage, but does not use full sight, lighting, cover, or active search.'],
    nextSteps: ['Keep labeled as manual-helper until it integrates with visibility and lighting.'],
  },
  {
    id: 'equipment.armor',
    label: 'Armor and equipment modifiers',
    category: 'equipment',
    mode: 'core-5e',
    status: 'partial',
    authority: 'shared',
    priority: 'P2',
    paths: ['shared/src/utils/equipmentBonuses.ts'],
    notes: [
      'AC calculation covers light, medium, heavy, shields, named armor defaults, magic AC bonuses, stealth disadvantage, and heavy armor speed penalties in shared tests.',
      'Combatant speed derivation applies manual heavy-armor speed penalties server-side and skips DDB-imported characters to avoid double-counting.',
    ],
    nextSteps: ['Keep armor disadvantage covered in both equipment and stealth-helper tests while broader visibility automation is added.'],
  },
  {
    id: 'resource.rests',
    label: 'Rests and resource recovery',
    category: 'resource',
    mode: 'core-5e',
    status: 'partial',
    authority: 'mixed',
    priority: 'P2',
    paths: ['client/src/utils/rest.ts', 'server/src/services/chatCommands/restHandlers.ts'],
    notes: [
      'DM !rest commands and player rest buttons both request server-owned character updates.',
      'Manual short-rest Hit Dice spending is also server-owned and rolls on the server.',
      'Manual spell-slot spend/refund counters request server-owned character updates.',
    ],
    nextSteps: ['Move remaining ad-hoc feature and item resource spend/refund flows into server-owned actions.'],
  },
  {
    id: 'content.monster-actions',
    label: 'Monster and compendium action normalization',
    category: 'monster',
    mode: 'core-5e',
    status: 'partial',
    authority: 'mixed',
    priority: 'P3',
    paths: ['server/src/services/Open5eService.ts', 'server/src/services/CombatService.ts'],
    notes: ['Raw stat-block fields are useful for browsing but not enough for reliable automated combat.'],
    nextSteps: ['Normalize attacks, saves, recharge, legendary actions, senses, defenses, and condition immunities.'],
  },
];

export function rulesByMode(mode: RuleMode): RulesMatrixEntry[] {
  return RULES_MATRIX.filter((entry) => entry.mode === mode);
}

export function rulesByPriority(priority: RulePriority): RulesMatrixEntry[] {
  return RULES_MATRIX.filter((entry) => entry.priority === priority);
}
