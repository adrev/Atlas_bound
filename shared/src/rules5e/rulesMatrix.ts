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
    status: 'partial',
    authority: 'server',
    priority: 'P1',
    paths: [
      'server/src/socket/combat/hpEvents.ts',
      'server/src/services/CombatService.ts',
    ],
    notes: [
      'A creature with three death-save successes is stable at 0 HP and remains unconscious.',
      'A natural 20 heals 1 HP and should clear unconscious/stable state.',
    ],
    nextSteps: [
      'Persist stable/unconscious state consistently.',
      'Enforce one death save per turn.',
    ],
  },
  {
    id: 'combat.healing-downed',
    label: 'Healing downed characters',
    category: 'combat',
    mode: 'core-5e',
    status: 'partial',
    authority: 'server',
    priority: 'P1',
    paths: ['server/src/services/CombatService.ts', 'server/src/socket/combat/hpEvents.ts'],
    notes: ['Healing above 0 HP should clear death saves plus stable/unconscious state.'],
    nextSteps: ['Broadcast token condition changes whenever healing changes downed-state conditions.'],
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
      'client/src/hooks/useDragToken.ts',
      'client/src/components/canvas/layers/MovementRangeLayer.tsx',
    ],
    notes: [
      'The default grid rule treats a diagonal square as one square.',
      'Optional diagonal variants should be session settings rather than hidden mismatches.',
    ],
    nextSteps: ['Use one distance function for range preview, drag spending, and server validation.'],
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
    authority: 'shared',
    priority: 'P1',
    paths: ['shared/src/rules/conditionEffects.ts'],
    notes: ['Slow and cover need flat save modifiers, not only advantage/disadvantage.'],
    nextSteps: ['Extend SaveModifierResult with flat modifiers and update callers.'],
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
      'server/src/services/chatCommands/spellsTier16Handler.ts',
    ],
    notes: ['Different spell paths roll damage, apply defenses, and mutate HP differently.'],
    nextSteps: ['Route one save-for-half spell family through a shared server resolver.'],
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
    notes: ['Opposed checks exist, but size, reach, free-hand, and action-cost constraints are incomplete.'],
    nextSteps: ['Add rules validation and tests before making these authoritative.'],
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
    notes: ['Current helper compares passive perception but does not use full sight, lighting, cover, or active search.'],
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
    nextSteps: ['Wire stealth disadvantage into authoritative stealth roll helpers if stealth becomes more automated.'],
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
      'DM !rest commands apply server-owned character updates so offline players and secondary tabs do not drift.',
      'Player quick-action rest buttons still use the client helper path.',
    ],
    nextSteps: ['Move player rest buttons to a server rest request event with the same update service.'],
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
