/**
 * D&D Beyond names some spells after their original creators
 * (Tasha's Hideous Laughter, Bigby's Hand, etc.) but the SRD/Open5e
 * compendium uses the generic name (Hideous Laughter, Arcane Hand). When
 * a player imports a character from DDB and clicks one of these spells,
 * we need to translate the DDB slug to the SRD slug to find the wiki page.
 *
 * Used by:
 *   • CompendiumOverlay  — listens for open-compendium-detail events and
 *     resolves the slug before passing it to the popup
 *   • CompendiumDetailPopup — runs the same lookup as a safety net so a
 *     direct fetch with a DDB-style slug also works
 */
export const SPELL_ALIASES: Record<string, string> = {
  'tashas-hideous-laughter': 'hideous-laughter',
  'melfs-acid-arrow': 'acid-arrow',
  'bigbys-hand': 'arcane-hand',
  'mordenkainens-sword': 'arcane-sword',
  'leomunds-tiny-hut': 'tiny-hut',
  'otilukes-resilient-sphere': 'resilient-sphere',
  'otilukes-freezing-sphere': 'freezing-sphere',
  'mordenkainens-magnificent-mansion': 'magnificent-mansion',
  'drawmijs-instant-summons': 'instant-summons',
  'evards-black-tentacles': 'black-tentacles',
  'tashas-caustic-brew': 'caustic-brew',
  'nystuls-magic-aura': 'arcanists-magic-aura',
  'rarys-telepathic-bond': 'telepathic-bond',
  'leomunds-secret-chest': 'secret-chest',
  'mordenkainens-private-sanctum': 'private-sanctum',
  'ottos-irresistible-dance': 'irresistible-dance',
  'tensers-floating-disk': 'floating-disk',
};

/**
 * Resolve a spell slug through the alias map. Returns the input unchanged
 * if no alias is registered.
 */
export function resolveSpellSlug(slug: string): string {
  return SPELL_ALIASES[slug] ?? slug;
}
