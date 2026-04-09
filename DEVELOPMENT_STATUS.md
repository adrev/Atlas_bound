# Atlas Bound — Development Status & Todo List

## Last Updated: April 7, 2026

---

## What Was Built Today (Session Summary)

### Image Generation (6,360 images, $0 cost)
- Generated AI art for ALL 3,207 creatures, 1,706 items, 1,435 spells using SDXL Turbo locally on M3 Max
- Downloaded 12 Open5e CC illustrations
- Token image tracking system (open5e/ai-generated/uploaded/generated)
- DM can upload custom icons for any creature, item, or spell
- Default fallback icon for items without art
- Scripts: `server/scripts/generate_local_tokens.py`, `generate_item_art.py`, `generate_spell_art.py`

### Creature Library Overhaul
- Replaced 52 hardcoded creatures → 3,207+ from compendium API with pagination
- Server-side search, type/CR filtering
- "View Full Stats" opens wiki popup, "Add to Map" spawns with full stats
- Token spawning uses PNG art (with SVG fallback)

### Loot & Inventory System
- Redesigned loot editor as slide-in panel with compendium search
- Equipped toggle on loot items (only equipped weapons show as attacks)
- Loot weapons appear as attack buttons with proper damage/modifiers
- Magic weapon bonus parsed from descriptions (+1/+2/+3 to hit and damage)
- Weapon type inference for magic weapons (Berserker Axe → 1d8 slashing)
- Custom item creation with weapon presets, damage dropdowns, property chips with tooltips
- Drop-on-map: items create lootable tokens near the character
- DDB inventory auto-enrichment (slug matching, images, stats)
- Dynamic AC calculation from equipped armor/shields (D&D 5e rules)
- Character inventory shows item images, rarity colors, wiki links, equip toggles

### Spell System Overhaul
- Spell UI: images, school colors, cantrip/spell split, wiki links
- Interactive spell slot pips (click to expend/restore)
- Spell slot consumption (prevents cast when empty)
- Spell attacks vs AC (hit/miss/critical with doubled dice)
- Saving throws auto-rolled (target ability mod vs caster DC)
- Half damage on save (parsed from description)
- Auto-detect attackType and savingThrow from spell description (strips HTML)
- Concentration tracking (drop old spell, CON save on damage)
- Cantrip damage scaling (2x at 5, 3x at 11, 4x at 17)
- Creature spellcasting trait parsing (Druid, Mage, etc. spells become castable)
- Condition auto-application (35+ spell-to-condition mappings)
- Spell animation integration (31 named spells + school-based defaults)
- Spell name aliases for DDB→SRD mapping (17 named spells)
- Self-range AoE spells auto-resolve (Thunderwave, Burning Hands)
- AoE auto-targeting: finds all tokens in radius, rolls saves for each
- Pushback parsing from description ("pushed 10 feet")

### Compendium/Wiki
- Item images, spell images in detail popups
- Weapon/armor stat boxes (damage, AC, properties, weight, cost)
- Markdown rendering for all descriptions (tables, bold, lists)
- Search result thumbnails
- Homebrew tab with custom items (create, edit, delete, image upload)
- Spell name aliases (Tasha's Hideous Laughter → hideous-laughter)

### PHB Equipment
- Seeded 88+ mundane items: all weapons, armor, shields, gear, currency, gems, art objects
- Currency: cp/sp/ep/gp/pp with CP values
- Structured rawJson with damage dice, properties, AC, weight, cost

### Other
- Hidden rolls: purple styling, DB persistence, filtered from players
- Token name labels: dynamic width, word wrap, proper sizing
- Git LFS setup, all pushed to GitHub

---

## Known Issues (Fix First Tomorrow)

### ✅ FIXED — Self-Range AoE Spells (Thunderwave)
**Status**: Fixed Apr 7. Replaced the setTimeout-based `castSelfSpell` helper with a full standalone async function that resolves directly from the cast button onClick without entering targeting mode at all. Filters out the caster up front, reads fresh HP from `useCharacterStore.getState()` right before each damage tick, schedules pushback BEFORE damage so dead tokens still move, rolls actual dice (not the average), skips already-dead tokens, falls back to compendium lookup for missing damage/save data, applies cantrip scaling at levels 5/11/17, and auto-applies SPELL_CONDITIONS on failed saves. Commits `bcf1153`, `6f9fdf8`.

### ✅ FIXED — AoE Damage Amounts (1-shot bug)
**Status**: Fixed Apr 7. Each affected token now reads fresh HP from `useCharacterStore.getState().allCharacters[charId]` right before applying damage so simultaneous applications never use a stale closure value.

### ✅ FIXED — Pushback Not Visible (dead tokens)
**Status**: Fixed Apr 7. Pushback is now scheduled at `delay = i * 200` and damage at `delay + 300` so the creature moves before the damage tick that might kill it.

### ✅ FIXED — Average damage on single-target spells
**Status**: Fixed Apr 7. The targeting useEffect was emitting dice notation to chat but applying the AVERAGE of the dice to HP. Added a `rollDamageDice` helper and replaced all four single-target damage application sites (spell attack vs AC, save failed full damage, save half-on-save, no-save direct damage, healing). Each branch also now reads fresh HP from the store before applying.

---

## Comprehensive Todo List

### Priority 1: Fix & Polish ✅ COMPLETE
- [x] Fix Self-range AoE spell resolution ✅ Apr 7
- [x] Fix AoE damage amounts ✅ Apr 7
- [x] Fix pushback timing ✅ Apr 7
- [x] Roll real dice for single-target spell damage ✅ Apr 7
- [x] Wire condition auto-application into Self-range AoE path ✅ Apr 7

### Priority 2: Combat Engine (mostly done)
- [x] **Initiative & Turn Flow**: Automated rolling on "Start Combat" ✅
- [x] **End Turn button**: Visible in InitiativeTracker during combat ✅
- [x] **Combat Loop**: Auto-cycle, skip dead, Start/End toggles ✅
- [x] **Movement Enforcement**: Distance tracking + speed limit + toast ✅ (partial — no split movement)
- [x] **Opportunity Attacks**: Detect leaving threatened square, popup ✅
- [x] **Action Tracking**: Action economy system (action/bonus/reaction/movement) ✅
- [x] **Attack vs AC comparison**: Roll + compare + announce hit/miss ✅
- [ ] **DM Group Actions**: Move/act with groups of identical creatures as block

### Priority 3: Spell System (mostly done)
- [x] AoE Spell Templates ✅ Apr 7
- [x] AoE Multi-Target ✅ Apr 7
- [x] Spell Pushback Effects ✅ Apr 7
- [x] Upcast Support ✅ Apr 7
- [x] Add/Remove Spell ✅ Apr 7
- [x] **Upcast damage scaling**: Parses "+1d6 per slot above 3rd" from descriptions ✅
- [x] **Spell Visual Effects**: Animations for 41 named spells + school defaults ✅
- [ ] **Ritual Casting**: Cast without slot if ritual (10 min)
- [ ] **Prepared Spells**: Distinguish known vs prepared

### ✅ Permission Audit — COMPLETE Apr 9
- [x] Server-side guards on 13 socket events (character:update, all combat events, hidden rolls)
- [x] Permission helpers: playerIsDM, isTokenOwnerOrDM, canTargetToken, isCurrentTurnOwnerOrDM

### Priority 4: Items & Inventory (mostly done)
- [x] **Thrown Weapons**: Drop from inventory, spawn item token at target ✅
- [x] **Item Creation from Wiki**: Homebrew tab with Monster/Spell/Item creation ✅ Apr 9
- [ ] **Disarm Mechanic**: Target drops equipped weapon as item token
- [ ] **DM "Send to Player"**: Transfer items between characters

### Priority 5: Map & Scene Management (mostly done)
- [x] **Scene Manager**: Multiple maps per campaign, DM preview, player ribbon ✅
- [x] **DM Pre-staging**: Preview different map, place tokens before activating ✅
- [x] **DM Vision Preview**: Banner shows when DM views different map than players ✅
- [x] **Persistent Walls**: Walls table in SQLite, survive map reload ✅
- [x] **Preset Map Sync Bug**: FIXED — map:activate-for-players broadcasts properly ✅
- [x] **Grid Opacity Slider**: FIXED — range input in settings works ✅
- [ ] **Auto-Grid Detection**: Algorithm to align VTT grid to uploaded map image

### Priority 6: DnD Beyond Integration
- [ ] **Level Up Sync Button**: Pull updated stats but preserve Current HP and Inventory
- [ ] **Re-import Flow**: Smart merge that doesn't overwrite local changes
- [ ] **Spell Slot Sync**: Match DDB spell slots to local state

### ✅ Priority 7: UI/UX Polish — COMPLETE Apr 9
- [x] **Hero tab rebuild**: Full TokenActionPanel parity via embedded mode ✅ Apr 9
- [x] **UI Consistency Pass**: All surfaces through theme.ts, Button primitive, pill chips ✅ Apr 9
- [x] **Chat System**: IC/OOC with distinct styling, whisper support ✅
- [x] **Turn Indicator**: Gold glow ring on current-turn token + active row ✅
- [x] **SVG Dice with tumble animation**: Polygon dice shapes with Roll20-style spin ✅ Apr 9
- [ ] **3D Dice Animations**: @3d-dice/dice-box integration
- [ ] **Sound/Ambiance System**: Background music, SFX for spells/attacks

### Priority 8: Infrastructure
- [ ] **Deploy to Google Cloud**: Dockerfile exists, needs GCP config
- [ ] **User Auth**: Login/persistent accounts
- [x] **Session Persistence**: Full state rehydration on reconnect ✅
- [ ] **Discord Integration**: Session summaries, notifications

---

## Tech Stack Reference
- **Frontend**: React 19 + Vite + TypeScript, Zustand stores, Konva.js canvas
- **Backend**: Express + Socket.io + SQLite (better-sqlite3)
- **Shared**: TypeScript monorepo (client/server/shared workspaces)
- **Compendium**: 3,207 monsters, 1,435 spells, 1,706 items from Open5e
- **Images**: 6,360+ AI-generated (SDXL Turbo, local), tracked via Git LFS
- **DB**: SQLite with 15+ tables, JSON columns for flexible data

## Key File Locations
| File | Purpose |
|------|---------|
| `client/src/components/canvas/TokenActionPanel.tsx` | Token info panel, spell/weapon resolution, targeting |
| `client/src/components/character/CharacterSheetFull.tsx` | Full character sheet with tabs |
| `client/src/components/compendium/CompendiumDetailPopup.tsx` | Wiki detail view for monsters/spells/items |
| `client/src/components/compendium/CompendiumPanel.tsx` | Wiki search sidebar |
| `client/src/components/loot/LootEditor.tsx` | Loot/inventory management panel |
| `client/src/components/dm/CreatureLibrary.tsx` | Creature spawning from compendium |
| `client/src/components/canvas/layers/TokenLayer.tsx` | Token rendering on canvas |
| `client/src/components/canvas/layers/EffectLayer.tsx` | AoE template rendering |
| `client/src/stores/useMapStore.ts` | Map state + targeting mode |
| `client/src/stores/useEffectStore.ts` | Spell animation state |
| `server/src/routes/loot.ts` | Loot CRUD + take/drop endpoints |
| `server/src/routes/compendium.ts` | Compendium search + monster detail API |
| `server/src/routes/customContent.ts` | Custom items/spells/monsters CRUD |
| `server/src/services/DndBeyondService.ts` | DDB character import/parsing |
| `server/src/socket/chatEvents.ts` | Chat + dice roll handling |
| `server/src/socket/combatEvents.ts` | Combat state management |
| `shared/src/constants/spell-animations.ts` | Spell animation configs |
| `shared/src/constants/spell-conditions.ts` | Spell → condition mappings |
| `shared/src/utils/equipmentBonuses.ts` | AC/stat calculation from gear |
