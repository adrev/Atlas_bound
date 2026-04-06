import type { Condition } from '../types/map.js';

export interface ConditionInfo {
  name: Condition;
  label: string;
  description: string;
  icon: string;
  color: string;
}

export const CONDITIONS: ConditionInfo[] = [
  { name: 'blinded', label: 'Blinded', description: 'Cannot see. Auto-fail sight checks. Attacks have disadvantage, attacks against have advantage.', icon: 'eye-off', color: '#4a4a4a' },
  { name: 'charmed', label: 'Charmed', description: 'Cannot attack the charmer. Charmer has advantage on social checks.', icon: 'heart', color: '#ff69b4' },
  { name: 'deafened', label: 'Deafened', description: 'Cannot hear. Auto-fail hearing checks.', icon: 'ear-off', color: '#888888' },
  { name: 'frightened', label: 'Frightened', description: 'Disadvantage on ability checks and attacks while source is in sight. Cannot willingly move closer.', icon: 'ghost', color: '#9b59b6' },
  { name: 'grappled', label: 'Grappled', description: 'Speed is 0. Ends if grappler is incapacitated or moved out of reach.', icon: 'grip-horizontal', color: '#e67e22' },
  { name: 'incapacitated', label: 'Incapacitated', description: 'Cannot take actions or reactions.', icon: 'ban', color: '#e74c3c' },
  { name: 'invisible', label: 'Invisible', description: 'Cannot be seen without magic. Attacks have advantage, attacks against have disadvantage.', icon: 'eye', color: '#3498db' },
  { name: 'paralyzed', label: 'Paralyzed', description: 'Incapacitated. Cannot move or speak. Auto-fail STR/DEX saves. Attacks have advantage, melee hits are crits.', icon: 'zap-off', color: '#f1c40f' },
  { name: 'petrified', label: 'Petrified', description: 'Transformed to stone. Weight x10. Incapacitated. Resistance to all damage.', icon: 'mountain', color: '#7f8c8d' },
  { name: 'poisoned', label: 'Poisoned', description: 'Disadvantage on attack rolls and ability checks.', icon: 'skull', color: '#27ae60' },
  { name: 'prone', label: 'Prone', description: 'Disadvantage on attacks. Melee attacks against have advantage, ranged have disadvantage. Must use half movement to stand.', icon: 'arrow-down', color: '#8b4513' },
  { name: 'restrained', label: 'Restrained', description: 'Speed is 0. Attacks have disadvantage. Attacks against have advantage. Disadvantage on DEX saves.', icon: 'lock', color: '#c0392b' },
  { name: 'stunned', label: 'Stunned', description: 'Incapacitated. Cannot move. Can only speak falteringly. Auto-fail STR/DEX saves.', icon: 'star', color: '#f39c12' },
  { name: 'unconscious', label: 'Unconscious', description: 'Incapacitated. Cannot move or speak. Unaware. Drop what held. Fall prone. Auto-fail STR/DEX saves.', icon: 'moon', color: '#2c3e50' },
  { name: 'exhaustion', label: 'Exhaustion', description: 'Cumulative penalties at each level. Level 6 = death.', icon: 'battery-low', color: '#95a5a6' },
];

export const CONDITION_MAP = new Map(CONDITIONS.map(c => [c.name, c]));
