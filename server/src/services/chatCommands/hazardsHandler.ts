import {
  registerChatCommand,
  whisperToCaller,
  broadcastSystem,
  type ChatCommandContext,
} from '../ChatCommands.js';
import * as ConditionService from '../ConditionService.js';
import pool from '../../db/connection.js';
import type { Token } from '@dnd-vtt/shared';
import type { PlayerContext } from '../../utils/roomState.js';
import { tokenConditionChanges } from '../../utils/conditionSources.js';

/**
 * Diseases + poisons catalog.
 *
 *   !disease <slug> <target>           — apply a disease; DC + target
 *                                        save rolled automatically
 *   !disease list                      — whisper the catalog
 *   !disease help <slug>               — whisper one entry's full text
 *
 *   !poison <slug> <target> [extra-dc] — apply a poison; resolves the
 *                                        initial save + damage inline
 *   !poison list / !poison help <slug> — same UX as !disease
 *
 * RAW source: DMG p.257-258 (poisons) + p.257 (diseases) + PHB/XGE
 * callouts. Each entry describes the save schedule + flavor so the
 * DM has the rule at hand.
 */

function resolveCallerToken(ctx: PlayerContext): Token | null {
  const all = Array.from(ctx.room.tokens.values());
  const own = all
    .filter((t) => (t as Token).ownerUserId === ctx.player.userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return own[0] ?? null;
}

function resolveTargetByName(ctx: PlayerContext, name: string): Token | null {
  const needle = name.toLowerCase();
  const matches = Array.from(ctx.room.tokens.values()).filter(
    (t) => t.name.toLowerCase() === needle,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return matches[0];
}

function roll(count: number, sides: number): { rolls: number[]; sum: number } {
  const rolls: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.floor(Math.random() * sides) + 1;
    rolls.push(r);
    sum += r;
  }
  return { rolls, sum };
}

async function loadTargetSaveMod(
  target: Token, ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
): Promise<{ mod: number; name: string }> {
  if (!target.characterId) return { mod: 0, name: target.name };
  try {
    const { rows } = await pool.query(
      'SELECT ability_scores, saving_throws, proficiency_bonus, name FROM characters WHERE id = $1',
      [target.characterId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const scores = (typeof row?.ability_scores === 'string'
      ? JSON.parse(row.ability_scores as string)
      : (row?.ability_scores ?? {})) as Record<string, number>;
    const prof = Number(row?.proficiency_bonus) || 2;
    const saves = typeof row?.saving_throws === 'string'
      ? JSON.parse(row.saving_throws as string)
      : (row?.saving_throws ?? []);
    const base = Math.floor((((scores?.[ability] ?? 10) - 10) / 2));
    const mod = base + (Array.isArray(saves) && saves.includes(ability) ? prof : 0);
    return { mod, name: (row?.name as string) || target.name };
  } catch {
    return { mod: 0, name: target.name };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Diseases — canonical PHB / DMG / XGE set
// ═══════════════════════════════════════════════════════════════════

interface Disease {
  name: string;
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveDc: number;
  onFail: string;
  cadence: string;
  cured: string;
  onApply?: 'poisoned' | null;
}

const DISEASES: Record<string, Disease> = {
  'sewer-plague': {
    name: 'Sewer Plague',
    saveAbility: 'con',
    saveDc: 11,
    onFail: 'Poisoned; can\'t regain HP except through magic; max HP reduced by 1 level of exhaustion equivalent per failed save schedule (per DMG).',
    cadence: 'Repeat CON DC 11 save at each long rest. 3 successes cure it; 3 failures gain 1 level of exhaustion (max 6 = death).',
    cured: 'Cleansed on 3rd success OR via Lesser Restoration / similar.',
    onApply: 'poisoned',
  },
  'sight-rot': {
    name: 'Sight Rot',
    saveAbility: 'con',
    saveDc: 15,
    onFail: 'Eyes water, vision blurs. Disadvantage on attack rolls + ability checks that rely on sight.',
    cadence: 'Until cured, suffer 1 permanent point of blindness per day of being infected.',
    cured: 'A handful of eyebright flowers applied to eyes as a paste. Or Lesser Restoration.',
  },
  'cackle-fever': {
    name: 'Cackle Fever',
    saveAbility: 'con',
    saveDc: 13,
    onFail: 'Stressful event (combat, taking damage, frightened): CON DC 13 or 1d10 psychic damage + uncontrollable laughter (incapacitated) 1 min. Save at end of each turn.',
    cadence: 'Long rest CON DC 13: success 2 → cured. Contagious to within 10 ft.',
    cured: 'Lesser Restoration.',
  },
  'mindfire': {
    name: 'Mindfire',
    saveAbility: 'int',
    saveDc: 12,
    onFail: 'Feverish delusions; INT reduced by 1d4, inflicts disadvantage on INT / CHA checks / saves.',
    cadence: 'Long rest INT DC 12. 3 successes cure.',
    cured: 'Lesser Restoration or 3 successful end-of-long-rest saves.',
  },
  'filth-fever': {
    name: 'Filth Fever',
    saveAbility: 'con',
    saveDc: 11,
    onFail: 'Disadvantage on STR / STR saves. Can\'t regain HP except through magic.',
    cadence: 'Long rest CON DC 11. 3 successes cure.',
    cured: 'Lesser Restoration.',
  },
};

async function handleDisease(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (!sub || sub === 'list' || sub === 'ls') {
    const lines: string[] = ['**Disease catalog** (use `!disease <slug> <target>` to apply):'];
    for (const [slug, d] of Object.entries(DISEASES)) {
      lines.push(`  • \`${slug}\` — ${d.name} (CON DC ${d.saveDc})`);
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }
  if (sub === 'help' || sub === 'info') {
    const slug = parts[1]?.toLowerCase();
    const d = slug ? DISEASES[slug] : undefined;
    if (!d) {
      whisperToCaller(c.io, c.ctx, `!disease help: unknown slug "${slug ?? ''}". Run \`!disease list\`.`);
      return true;
    }
    whisperToCaller(c.io, c.ctx,
      `**${d.name}** (${d.saveAbility.toUpperCase()} DC ${d.saveDc})\n  Effect: ${d.onFail}\n  Cadence: ${d.cadence}\n  Cure: ${d.cured}`);
    return true;
  }
  const disease = DISEASES[sub];
  if (!disease) {
    whisperToCaller(c.io, c.ctx, `!disease: unknown "${sub}". Run \`!disease list\`.`);
    return true;
  }
  const targetName = parts.slice(1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!disease: no token named "${targetName}".`);
    return true;
  }

  const saveMod = await loadTargetSaveMod(target, disease.saveAbility);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + saveMod.mod;
  const saved = total >= disease.saveDc;
  const sign = saveMod.mod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;

  const lines: string[] = [];
  lines.push(`🦠 **${disease.name}** — ${saveMod.name} ${disease.saveAbility.toUpperCase()} DC ${disease.saveDc}:`);
  lines.push(`   d20=${d20}${sign}${saveMod.mod}=${total} → ${saved ? 'SAVED — disease does not take hold' : 'FAILED — contracted'}`);
  if (!saved) {
    lines.push(`   Effect: ${disease.onFail}`);
    lines.push(`   Cadence: ${disease.cadence}`);
    if (disease.onApply) {
      ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
        name: disease.onApply,
        source: `Disease: ${disease.name}`,
        appliedRound: currentRound,
        expiresAfterRound: currentRound + 100000,
      });
      c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
        tokenId: target.id,
        changes: tokenConditionChanges(c.ctx.room, target.id),
      });
    }
  }
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Poisons — canonical DMG p.257-258
// ═══════════════════════════════════════════════════════════════════

type PoisonKind = 'injury' | 'ingested' | 'contact' | 'inhaled';

interface Poison {
  name: string;
  kind: PoisonKind;
  priceGp: number;
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  saveDc: number;
  damageDice?: { count: number; die: number };
  damageType?: string;
  halfOnSave?: boolean;
  effect: string;
  extraCondition?: 'poisoned' | 'unconscious' | 'paralyzed' | 'incapacitated' | 'blinded';
  durationRounds?: number; // for auto-expiry
}

const POISONS: Record<string, Poison> = {
  'drow-poison': {
    name: 'Drow Poison', kind: 'injury', priceGp: 200,
    saveAbility: 'con', saveDc: 13,
    extraCondition: 'poisoned', durationRounds: 600, // 1 hour
    effect: 'Poisoned 1 hour. If failed by 5+: also unconscious until damaged or shaken awake.',
  },
  'wyvern-poison': {
    name: 'Wyvern Poison', kind: 'injury', priceGp: 1200,
    saveAbility: 'con', saveDc: 15,
    damageDice: { count: 7, die: 6 }, damageType: 'poison', halfOnSave: true,
    effect: 'CON DC 15 or 7d6 poison (half on save).',
  },
  'crawler-mucus': {
    name: 'Crawler Mucus (Carrion Crawler)', kind: 'contact', priceGp: 200,
    saveAbility: 'con', saveDc: 13,
    extraCondition: 'paralyzed', durationRounds: 10,
    effect: 'Paralyzed 1 min. CON DC 13 save at end of each turn to end.',
  },
  'assassins-blood': {
    name: "Assassin's Blood", kind: 'ingested', priceGp: 150,
    saveAbility: 'con', saveDc: 10,
    damageDice: { count: 3, die: 6 }, damageType: 'poison', halfOnSave: true,
    extraCondition: 'poisoned', durationRounds: 14400, // 24 h approx
    effect: '3d6 poison + poisoned 24 h (half dmg + no poisoning on save).',
  },
  'basic-poison': {
    name: 'Basic Poison', kind: 'injury', priceGp: 100,
    saveAbility: 'con', saveDc: 10,
    damageDice: { count: 1, die: 4 }, damageType: 'poison',
    effect: 'Coat 1 weapon or 10 pieces of ammunition. +1d4 poison damage on next hit within 1 min.',
  },
  'midnight-tears': {
    name: 'Midnight Tears', kind: 'ingested', priceGp: 1500,
    saveAbility: 'con', saveDc: 17,
    damageDice: { count: 9, die: 6 }, damageType: 'poison', halfOnSave: true,
    effect: 'Delayed: at midnight after ingestion, CON DC 17 or 9d6 poison (half on save). Undetectable in food.',
  },
  'pale-tincture': {
    name: 'Pale Tincture', kind: 'ingested', priceGp: 250,
    saveAbility: 'con', saveDc: 16,
    damageDice: { count: 1, die: 6 }, damageType: 'poison',
    extraCondition: 'poisoned', durationRounds: 14400,
    effect: '1d6 poison + poisoned 24 h. Max HP can\'t be restored by any means while poisoned. Reduces max HP by dmg taken until Greater Restoration.',
  },
  'serpent-venom': {
    name: 'Serpent Venom', kind: 'injury', priceGp: 200,
    saveAbility: 'con', saveDc: 11,
    damageDice: { count: 3, die: 6 }, damageType: 'poison', halfOnSave: true,
    effect: '3d6 poison (half on save).',
  },
  'truth-serum': {
    name: 'Truth Serum', kind: 'ingested', priceGp: 150,
    saveAbility: 'con', saveDc: 11,
    effect: 'Can\'t knowingly speak a lie for 1 hour. Save again each hour to end early.',
  },
  'oil-of-taggit': {
    name: 'Oil of Taggit', kind: 'contact', priceGp: 400,
    saveAbility: 'con', saveDc: 13,
    extraCondition: 'unconscious', durationRounds: 14400,
    effect: 'Unconscious 24 h or until taking damage.',
  },
  'purple-worm-poison': {
    name: 'Purple Worm Poison', kind: 'injury', priceGp: 2000,
    saveAbility: 'con', saveDc: 19,
    damageDice: { count: 12, die: 6 }, damageType: 'poison', halfOnSave: true,
    effect: '12d6 poison (half on save).',
  },
  'essence-of-ether': {
    name: 'Essence of Ether', kind: 'inhaled', priceGp: 300,
    saveAbility: 'con', saveDc: 15,
    extraCondition: 'poisoned', durationRounds: 4800, // 8 hours
    effect: 'Poisoned 8 hours + unconscious. Wakes if damaged or shaken.',
  },
  'malice': {
    name: 'Malice', kind: 'inhaled', priceGp: 250,
    saveAbility: 'con', saveDc: 15,
    extraCondition: 'blinded', durationRounds: 600,
    effect: 'Blinded for 1 hour.',
  },
  'torpor': {
    name: 'Torpor', kind: 'ingested', priceGp: 600,
    saveAbility: 'con', saveDc: 15,
    extraCondition: 'incapacitated', durationRounds: 1440, // 4d6 hrs avg; use 4 hrs
    effect: 'Incapacitated 4d6 hours. Save again each hour to recover early.',
  },
};

async function handlePoison(c: ChatCommandContext): Promise<boolean> {
  const parts = c.rest.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (!sub || sub === 'list' || sub === 'ls') {
    const lines: string[] = ['**Poison catalog** (use `!poison <slug> <target>` to apply):'];
    const grouped: Record<string, string[]> = {};
    for (const [slug, p] of Object.entries(POISONS)) {
      if (!grouped[p.kind]) grouped[p.kind] = [];
      grouped[p.kind].push(`  • \`${slug}\` — ${p.name} (${p.priceGp} gp, ${p.saveAbility.toUpperCase()} DC ${p.saveDc})`);
    }
    for (const kind of ['injury', 'ingested', 'contact', 'inhaled']) {
      if (grouped[kind]?.length) {
        lines.push('');
        lines.push(`__${kind.charAt(0).toUpperCase() + kind.slice(1)}__`);
        lines.push(...grouped[kind]);
      }
    }
    whisperToCaller(c.io, c.ctx, lines.join('\n'));
    return true;
  }
  if (sub === 'help' || sub === 'info') {
    const slug = parts[1]?.toLowerCase();
    const p = slug ? POISONS[slug] : undefined;
    if (!p) {
      whisperToCaller(c.io, c.ctx, `!poison help: unknown slug "${slug ?? ''}".`);
      return true;
    }
    whisperToCaller(c.io, c.ctx,
      `**${p.name}** — ${p.kind.toUpperCase()} (${p.priceGp} gp)\n  Save: ${p.saveAbility.toUpperCase()} DC ${p.saveDc}\n  Effect: ${p.effect}`);
    return true;
  }
  const poison = POISONS[sub];
  if (!poison) {
    whisperToCaller(c.io, c.ctx, `!poison: unknown "${sub}". Run \`!poison list\`.`);
    return true;
  }
  const targetName = parts.slice(1).join(' ');
  const target = resolveTargetByName(c.ctx, targetName);
  if (!target) {
    whisperToCaller(c.io, c.ctx, `!poison: no token named "${targetName}".`);
    return true;
  }

  const saveMod = await loadTargetSaveMod(target, poison.saveAbility);
  const d20 = Math.floor(Math.random() * 20) + 1;
  const total = d20 + saveMod.mod;
  const saved = total >= poison.saveDc;
  const sign = saveMod.mod >= 0 ? '+' : '';
  const currentRound = c.ctx.room.combatState?.roundNumber ?? 0;

  const lines: string[] = [];
  lines.push(`☠ **${poison.name}** (${poison.kind}, ${poison.priceGp} gp) — ${saveMod.name} ${poison.saveAbility.toUpperCase()} DC ${poison.saveDc}:`);
  lines.push(`   d20=${d20}${sign}${saveMod.mod}=${total} → ${saved ? 'SAVED' : 'FAILED'}`);

  if (poison.damageDice) {
    const { rolls, sum } = roll(poison.damageDice.count, poison.damageDice.die);
    const dmg = saved && poison.halfOnSave ? Math.floor(sum / 2) : saved ? 0 : sum;
    const dt = poison.damageType ?? 'poison';
    lines.push(`   ${poison.damageDice.count}d${poison.damageDice.die} ${dt} [${rolls.join(',')}] = ${dmg} dmg`);
  }
  if (!saved && poison.extraCondition) {
    ConditionService.applyConditionWithMeta(c.ctx.room.sessionId, target.id, {
      name: poison.extraCondition,
      source: `Poison: ${poison.name}`,
      appliedRound: currentRound,
      expiresAfterRound: currentRound + (poison.durationRounds ?? 10),
    });
    c.io.to(c.ctx.room.sessionId).emit('map:token-updated', {
      tokenId: target.id,
      changes: tokenConditionChanges(c.ctx.room, target.id),
    });
    lines.push(`   → ${poison.extraCondition.toUpperCase()} ${poison.durationRounds ? `for ~${Math.round(poison.durationRounds / 10)} min` : ''}`);
  }
  lines.push(`   ${poison.effect}`);
  broadcastSystem(c.io, c.ctx, lines.join('\n'));
  return true;
}

registerChatCommand(['disease', 'sick'], handleDisease);
registerChatCommand('poison', handlePoison);
