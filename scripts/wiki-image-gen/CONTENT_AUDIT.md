# Wiki content audit — Atlas Bound vs dnd5e.wikidot.com

Snapshot of coverage as of the commit this doc lands on. Scoped check:
the user asked whether we've "included all the relevant information
from https://dnd5e.wikidot.com/ in our wiki." Short answer: we cover
the PHB core end-to-end, but miss a wide band of XGE / TCE /
setting-specific content that wikidot surfaces.

## Coverage summary

| Category | Atlas Bound | dnd5e.wikidot | Gap |
|---|---|---|---|
| Classes | 13 (PHB + Artificer) | 14 (+ Blood Hunter) | Minor |
| Races | 9 (PHB only) | ~45+ including exotic/monstrous/setting | **Large** |
| Backgrounds | 13 (PHB) | 40+ (XGE/SCAG/setting-specific) | **Large** |
| Feats | 14 (common PHB) | 60+ (PHB + XGE + TCE + racial) | Medium |
| Rules | 15 (core mechanics) | Similar core set | Parity |
| Conditions | 15 (full PHB) | 15 | ✓ Complete |
| Spells | ~1400 (compendium) | Full 5e list | ✓ Complete |
| Items | ~1700 (compendium) | Full 5e list | ✓ Complete |
| Monsters | ~4600 (compendium) | Full 5e list | ✓ Complete |

## P1 — Worth adding

### Races (exotic / monstrous)
Most important gap for character creation. The PHB 9 covers the
common cases but players routinely pick from:

- **Elemental Evil Player's Companion**: Aarakocra, Genasi (Air, Earth, Fire, Water), Goliath
- **Volo's / Mordenkainen's**: Aasimar (3 subraces), Bugbear, Centaur, Changeling, Firbolg, Githyanki, Githzerai, Goblin, Hobgoblin, Kenku, Kobold, Lizardfolk, Loxodon, Minotaur, Orc, Satyr, Shifter (4 subraces), Tabaxi, Tortle, Triton, Yuan-Ti
- **Fizban's**: Dragonborn subraces (Chromatic, Gem, Metallic)
- **Strixhaven / Spelljammer / Theros**: Owlin, Fairy, Autognome, Hadozee, Plasmoid, Thri-kreen, Vedalken, Leonin

### Feats (XGE / TCE / published racial)
Currently covers the 14 most-common PHB feats. Missing popular entries:

- **PHB**: Actor, Athlete, Charger, Crossbow Expert¹, Dual Wielder,
  Dungeon Delver, Elemental Adept², Grappler, Heavily Armored,
  Heavy Armor Master, Keen Mind, Linguist, Martial Adept, Medium
  Armor Master, Mounted Combatant, Observant, Savage Attacker,
  Skilled, Spell Sniper, Tavern Brawler, Weapon Master

- **Tasha's**: Artificer Initiate, Chef, Crusher, Eldritch Adept,
  Fey Touched, Fighting Initiate, Gunner, Metamagic Adept, Piercer,
  Poisoner, Shadow Touched, Skill Expert, Slasher, Telekinetic,
  Telepathic

- **Racial feats** (Dragonborn Fury, Dwarven Fortitude, Elven
  Accuracy, Flames of Phlegethos, Orcish Fury, Second Chance, Squat
  Nimbleness, Wood Elf Magic, Bountiful Luck, Drow High Magic,
  Infernal Constitution, Prodigy, Revenant Blade, etc.)

¹ Already implemented as a chat command (`!crossbowexpert`) but not
in the wiki glossary.
² Already implemented as a chat command (`!elementaladept`) but not
in the wiki glossary.

### Backgrounds
13 PHB out of 40+ published:

- **XGE/SCAG**: City Watch, Clan Crafter, Cloistered Scholar,
  Courtier, Faction Agent, Far Traveler, Inheritor, Knight of the
  Order, Mercenary Veteran, Urban Bounty Hunter, Uthgardt Tribe
  Member, Waterdhavian Noble
- **Curse of Strahd**: Haunted One
- **Storm King's Thunder**: Uthgardt Tribe Member
- **ToA**: Anthropologist, Archaeologist
- **TCE**: Feylost, Witchlight Hand
- **Wildemount**: Grinner, Volstrucker Agent

## P2 — Worth considering

### Missing categories wikidot surfaces
- **Sidekicks** (TCE L1–6 companion rules)
- **Blessings** (DMG supernatural gifts)
- **Charms** (DMG lesser gifts)
- **Dark Gifts** (Ravenloft — pair with CoS / VRGR)
- **Epic Boons** (DMG L20+ rewards)
- **Mounts & Vehicles** (beyond the handful already in items)
- **Madness** (DMG long/short/indefinite tables)

### Class variant: Blood Hunter
Matt Mercer's class, widely played. Not PHB but popular enough that
wikidot includes it. Skip unless user explicitly wants it.

## Content we have that wikidot lacks

- **Transparency breakdown cards** (attack / spell / save / action)
- **Chat-command surface for every class / subclass feature** — much
  deeper than static wiki pages
- **In-session condition stripes + auto-tracking** — wikidot is
  reference-only; we wire conditions to the combat engine
- **Initiative breakdown with per-source modifiers** — not a wiki
  feature at all
- **Session-scoped rule toggles** (`ruleSources`) so a PHB-only
  table doesn't see Tasha's content

## Recommended next action

If the user wants to close gaps, prioritize in this order:

1. **Races** — highest impact; character-creation UX hits this daily
2. **Feats** — second-highest; level-ups frequently involve choosing
   a feat the player wants to look up
3. **Backgrounds** — lower frequency; nice-to-have
4. **Missing categories** — only if a campaign actually needs them

I'd estimate ~3–4 hours of focused work per category to add the
entries + regenerate images. Everything hangs off the same glossary
pattern — add rows to the `.ts` file, the wiki surface picks them up
automatically.
