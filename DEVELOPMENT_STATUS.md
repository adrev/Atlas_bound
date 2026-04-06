# Atlas Bound — Development Status & Todo List

## Last Updated: April 6, 2026

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

### 🔴 Critical: Self-Range AoE Spells (Thunderwave)
**Problem**: Thunderwave sometimes doesn't resolve properly. The `castSelfSpell` helper enters targeting mode and auto-triggers the caster's token via setTimeout(50ms), but the timing can race with React re-renders.

**What we tried**:
1. Self-target only → damaged the caster
2. Skip self, announce "click each creature" → clunky UX
3. Auto-target all tokens in radius → worked but sometimes 1-shots (HP reading issue)
4. `castSelfSpell` auto-dispatch → timing race

**Fix approach**: Instead of the setTimeout race, resolve Self-range AoE spells directly in the cast button onClick without entering targeting mode at all. Extract the AoE resolution logic into a reusable function that takes the caster position and applies to all nearby tokens.

**Files**: `client/src/components/canvas/TokenActionPanel.tsx`
- Lines ~447-540: AoE resolution block
- Lines ~1315, 1340: spell cast button onClick handlers
- The `castSelfSpell` function at ~line 1409

### 🟡 AoE Damage Amounts
**Problem**: Some creatures getting 1-shot by AoE spells (342 HP creature killed by 2d8 damage). Need to verify HP is read correctly from character store for each affected token.

### 🟡 Pushback Not Visible
**Problem**: Token pushback works in code but may not be visible if the creature is dead after damage. Need to apply pushback BEFORE or simultaneously with damage.

---

## Comprehensive Todo List

### Priority 1: Fix & Polish (Do First)
- [ ] Fix Self-range AoE spell resolution (Thunderwave, Burning Hands) — extract into direct resolution function
- [ ] Fix AoE damage amounts (verify HP reading for each target)
- [ ] Fix pushback timing (apply before damage or simultaneously)
- [ ] Verify all spells with saves work (Poison Spray CON, Hold Person WIS, Fireball DEX)

### Priority 2: Combat Engine
- [ ] **Initiative & Turn Flow**: Automated rolling for all participants on "Start Combat"
- [ ] **End Turn button**: Persistent, high-visibility near dice tray
- [ ] **DM Group Actions**: Move/act with groups of identical creatures, end turn as block
- [ ] **Combat Loop**: Auto-cycle to top of order, skip dead, Start/End Combat toggles
- [ ] **Movement Enforcement**: Track distance moved per turn, enforce Speed stat, split movement
- [ ] **Opportunity Attacks**: Detect when token leaves threatened square, popup notification
- [ ] **Action Tracking**: Validate attacks/spells per turn based on character stats
- [ ] **Attack vs AC comparison**: Roll d20 + attack mod, compare to target AC, announce hit/miss

### Priority 3: Spell System Completion
- [ ] **AoE Spell Templates**: Visual cone/sphere/cube/line templates on map before confirming cast
- [ ] **AoE Multi-Target**: Click to place AoE origin, auto-select all tokens in shape
- [ ] **Spell Pushback Effects**: Thunderwave 10ft push, Eldritch Blast push invocation
- [ ] **Spell Visual Effects**: Expanding ring for AoE, projectile for ranged, glow for buff
- [ ] **Upcast Support**: Choose higher spell slot, scale damage dice accordingly
- [ ] **Ritual Casting**: Cast without slot if ritual (takes 10 min)
- [ ] **Prepared Spells**: Distinguish known vs prepared (for Wizards, Clerics, etc.)

### Priority 4: Items & Inventory
- [ ] **Thrown Weapons**: Drop from inventory on throw, create item token at target, damage target
- [ ] **Disarm Mechanic**: Target drops equipped weapon as item token
- [ ] **DM "Send to Player"**: Transfer items between characters
- [ ] **Item Creation from Wiki**: Create custom items/spells/monsters from Homebrew wiki tab (not just loot editor)
- [ ] **Spell Visualization Templates**: Geometric templates for cone/radius/line on grid

### Priority 5: Map & Scene Management
- [ ] **Layered Scene System**: Multiple map layers per campaign
- [ ] **DM Pre-staging**: Place tokens, set lighting privately before publishing to players
- [ ] **Auto-Grid Detection**: Algorithm to align VTT grid to uploaded map image
- [ ] **Fog of War Improvements**: DM "Vision Preview" to see what each player sees
- [ ] **Dynamic Lighting**: Walls remain permanently visible once placed
- [ ] **Preset Map Sync Bug**: Fix player view not updating on map change
- [ ] **Grid Opacity Slider**: Fix in Game Settings

### Priority 6: DnD Beyond Integration
- [ ] **Level Up Sync Button**: Pull updated stats but preserve Current HP and Inventory
- [ ] **Re-import Flow**: Smart merge that doesn't overwrite local changes
- [ ] **Spell Slot Sync**: Match DDB spell slots to local state

### Priority 7: UI/UX Polish
- [ ] **UI Consistency Pass**: Unified color theme, replace emoji icons with Lucide icons, standardize button/card/panel styling
- [ ] **Chat System**: IC (character name) vs OOC (player name) with distinct styling
- [ ] **Turn Indicator**: Clear visual for whose turn it is and which token is active
- [ ] **Dice Animations**: 3D dice rolling (@3d-dice/dice-box already in deps)
- [ ] **Sound/Ambiance System**: Background music, SFX for spells/attacks

### Priority 8: Infrastructure
- [ ] **Deploy to Google Cloud**: Dockerfile exists, needs setup
- [ ] **User Auth**: Login/persistent accounts
- [ ] **Session Persistence**: Save/restore full game state
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
