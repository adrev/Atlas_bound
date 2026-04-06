import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/nano-banana-pro-preview:generateContent?key=${API_KEY}`;
const MAP_DIR = path.join(__dirname, '..', 'client', 'public', 'maps');
const TOKEN_DIR = path.join(__dirname, '..', 'client', 'public', 'tokens');
fs.mkdirSync(MAP_DIR, { recursive: true });
fs.mkdirSync(TOKEN_DIR, { recursive: true });

const MAP_SUFFIX = ', flat top-down birds-eye view looking straight down, D&D tabletop RPG battle map, flat 2D map style, no perspective, no 3D, no isometric, no people, no characters, no text, no labels, no grid lines, no grid overlay, realistic fantasy painting style with rich textures and lighting, high detail';

const TOKEN_SUFFIX = ', circular portrait token for a tabletop RPG game, dark moody background, centered face and upper body, fantasy art style, detailed illustration, no text, no labels, no border, no decorations';

const MAPS = [
  { file: 'goblin-camp.png', prompt: 'Forest clearing with a makeshift goblin camp, ring of wooden spike fences, canvas tents around a central stone campfire pit, dirt paths, fallen logs and boulders, dense dark pine forest surrounding the clearing, warm firelight' + MAP_SUFFIX },
  { file: 'underdark-cavern.png', prompt: 'Underground Underdark cave system, dark purple-blue stone floor, cavern chambers connected by passages, glowing cyan bioluminescent mushrooms, pools of luminous blue water, stone bridge over a chasm, purple crystals' + MAP_SUFFIX },
  { file: 'druid-grove.png', prompt: 'Sacred forest clearing with a stone circle, twelve standing stones on green grass, stone altar in center, four massive ancient oak trees in corners, winding blue stream, wildflowers and ferns, dappled sunlight' + MAP_SUFFIX },
  { file: 'moonrise-towers.png', prompt: 'Dark gothic fortress courtyard, thick castle walls, round guard towers at corners, iron portcullis gate, cracked dark stone floor, glowing blue arcane ritual circle in center, rubble, green lanterns, purple banners' + MAP_SUFFIX },
  { file: 'nautiloid-wreck.png', prompt: 'Crashed alien organic ship interior, curved ribbed walls in dark purple and red, bio-mechanical corridors, strange pod chambers, scattered debris, small fires, organic tentacle structures' + MAP_SUFFIX },
  { file: 'grymforge.png', prompt: 'Ancient underground dwarven forge complex, stone platforms separated by channels of flowing orange lava, stone bridges, large anvils and forge workstations, carved pillars with dwarven runes' + MAP_SUFFIX },
  { file: 'forest-road-ambush.png', prompt: 'Long narrow dirt road through dense forest, fallen trees blocking sections, overturned wooden cart, thick bushes on both sides, tall pine trees casting shadows, morning mist' + MAP_SUFFIX },
  { file: 'zhentarim-hideout.png', prompt: 'Underground stone dungeon hideout, large central room with meeting table, smaller rooms branching off via corridors, crates and barrels, weapon racks, small underground dock with boat, torch sconces' + MAP_SUFFIX },
  { file: 'elfsong-tavern.png', prompt: 'Medieval fantasy tavern interior, warm wooden plank floor, L-shaped bar counter with stools, round tables with chairs, large stone fireplace, wooden staircase, barrels behind the bar, candlelight' + MAP_SUFFIX },
  { file: 'last-light-inn.png', prompt: 'Fortified medieval inn with courtyard, stone building with common room, fireplace, bar, guest bedrooms with beds, attached stable with horse stalls, courtyard with stone well, wooden palisade fence' + MAP_SUFFIX },
  { file: 'cathedral-lathander.png', prompt: 'Grand medieval cathedral interior, white and gold marble floor with mosaic patterns, rows of wooden pews, ornate golden altar on raised platform, stone columns, side chapel alcoves, golden candelabras, warm golden light' + MAP_SUFFIX },
  { file: 'wine-cellar.png', prompt: 'Underground stone wine cellar, grey cobblestone floor, thick stone walls, arched alcoves filled with horizontal wooden barrels, wooden crates, stone staircase in corner, stone pillars, puddles, torch sconces' + MAP_SUFFIX },
  { file: 'apothecary-shop.png', prompt: 'Small fantasy potion shop interior, wooden floor, shelving with colorful potion bottles, central worktable with alchemy equipment, iron cauldron with green liquid, shop counter near door, dried herbs hanging from ceiling' + MAP_SUFFIX },
  { file: 'camp-long-rest.png', prompt: 'Nighttime wilderness campsite clearing, stone-ringed campfire with warm orange glow, bedrolls in a circle, small canvas tent, adventuring gear, fallen log bench, dark forest trees surrounding, stream along one edge, starry sky' + MAP_SUFFIX },
  { file: 'merchant-quarter.png', prompt: 'Medieval town marketplace square, grey cobblestone streets, circular stone fountain in center, colorful market stalls with striped canopy roofs, shop fronts along edges, barrels and crates, street lanterns, narrow alleyways' + MAP_SUFFIX },
  { file: 'dense-forest.png', prompt: 'Dense enchanted forest area, dark green grass, many tree canopies scattered densely, fallen logs, thick bushes, small mossy clearing in center, rocks and boulders, winding dirt paths, forest floor with leaves' + MAP_SUFFIX },
  { file: 'long-road.png', prompt: 'Long dirt road stretching horizontally across the image, wide brown dirt road with cart tracks, green grassy fields on both sides, scattered trees along roadside, stone mile marker, wooden bridge over stream crossing the road' + MAP_SUFFIX },
];

const CREATURES = [
  { file: 'rat.png', prompt: 'A giant brown rat with glowing red eyes and matted fur, snarling aggressively' + TOKEN_SUFFIX },
  { file: 'wolf.png', prompt: 'A fierce grey wolf with yellow eyes, growling and showing sharp teeth' + TOKEN_SUFFIX },
  { file: 'goblin.png', prompt: 'A green-skinned goblin with pointed ears wearing leather scraps, holding a rusty dagger with a sneering expression' + TOKEN_SUFFIX },
  { file: 'kobold.png', prompt: 'A small red-scaled kobold with yellow eyes wearing a crude helmet and holding a tiny spear' + TOKEN_SUFFIX },
  { file: 'skeleton.png', prompt: 'An animated skeleton warrior with glowing blue eye sockets, wearing rusted armor fragments and holding an old sword' + TOKEN_SUFFIX },
  { file: 'zombie.png', prompt: 'A shambling undead zombie with rotting grey-green skin and torn clothing, empty milky white eyes' + TOKEN_SUFFIX },
  { file: 'bandit.png', prompt: 'A rugged human bandit with a scar across his face, wearing a dark hood and leather armor' + TOKEN_SUFFIX },
  { file: 'giant-spider.png', prompt: 'A large hairy black spider with eight glowing green eyes and dripping venomous fangs' + TOKEN_SUFFIX },
  { file: 'orc.png', prompt: 'A muscular green-skinned orc warrior with tusks and tribal war paint, wearing heavy iron armor and wielding a battle axe' + TOKEN_SUFFIX },
  { file: 'gnoll.png', prompt: 'A fierce hyena-headed gnoll with spotted brown fur, wearing bone necklaces and crude armor' + TOKEN_SUFFIX },
  { file: 'bugbear.png', prompt: 'A large hairy bugbear with orange-brown fur and small cruel eyes, wearing patchwork armor' + TOKEN_SUFFIX },
  { file: 'ogre.png', prompt: 'A massive fat ogre with grey-green skin, wearing animal hide loincloth and carrying a huge wooden club' + TOKEN_SUFFIX },
  { file: 'owlbear.png', prompt: 'A fearsome owlbear with an owl head on a bear body, brown feathers and fur, sharp beak and claws' + TOKEN_SUFFIX },
  { file: 'minotaur.png', prompt: 'A powerful minotaur with a bull head and muscular human body, large curved horns and red eyes' + TOKEN_SUFFIX },
  { file: 'basilisk.png', prompt: 'An eight-legged reptilian basilisk with grey-green scales and glowing petrifying yellow eyes' + TOKEN_SUFFIX },
  { file: 'troll.png', prompt: 'A tall lanky green troll with long arms, sharp claws, and regenerating wounds visible on its body' + TOKEN_SUFFIX },
  { file: 'manticore.png', prompt: 'A manticore with a lion body, large bat wings, and a scorpion tail covered in spikes' + TOKEN_SUFFIX },
  { file: 'griffon.png', prompt: 'A majestic griffon with an eagle head and golden wings on a powerful lion body' + TOKEN_SUFFIX },
  { file: 'displacer-beast.png', prompt: 'A panther-like displacer beast with six legs and two long tentacles on its back, dark blue-black fur' + TOKEN_SUFFIX },
  { file: 'hook-horror.png', prompt: 'A hulking hook horror with a vulture-like head and grey exoskeleton, massive hook-shaped claws for hands' + TOKEN_SUFFIX },
  { file: 'mind-flayer.png', prompt: 'A mind flayer illithid with purple skin, four facial tentacles, bulbous head, wearing elegant dark robes' + TOKEN_SUFFIX },
  { file: 'beholder.png', prompt: 'A floating beholder aberration, large central eye, many eye stalks, wide mouth with sharp teeth, round body' + TOKEN_SUFFIX },
  { file: 'young-red-dragon.png', prompt: 'A young red dragon with crimson scales, wings spread, horned head, breathing orange fire' + TOKEN_SUFFIX },
  { file: 'adult-red-dragon.png', prompt: 'A massive ancient red dragon with dark crimson scales, enormous wings, crown of horns, terrifying' + TOKEN_SUFFIX },
  { file: 'lich.png', prompt: 'An undead lich with a skeletal face, glowing green eyes in hollow sockets, ornate dark purple robes, holding a glowing staff' + TOKEN_SUFFIX },
  { file: 'guard.png', prompt: 'A human town guard in chainmail armor with a city tabard, holding a spear and shield, stern expression' + TOKEN_SUFFIX },
  { file: 'knight.png', prompt: 'A noble human knight in shining plate armor with plumed helmet, holding a longsword heroically' + TOKEN_SUFFIX },
  { file: 'mage.png', prompt: 'A human wizard with a long grey beard, wearing blue robes with star patterns, holding a glowing magical staff' + TOKEN_SUFFIX },
  { file: 'assassin.png', prompt: 'A hooded assassin in dark leather armor, face partially hidden by a black mask, dual wielding daggers' + TOKEN_SUFFIX },
  { file: 'bandit-captain.png', prompt: 'A scarred human bandit captain with an eyepatch, wearing studded leather and wielding a cutlass' + TOKEN_SUFFIX },
  { file: 'gelatinous-cube.png', prompt: 'A transparent gelatinous cube monster, faintly visible square shape with objects and bones floating inside' + TOKEN_SUFFIX },
  { file: 'mimic.png', prompt: 'A mimic monster disguised as a wooden treasure chest with teeth forming around the lid and a sticky tongue' + TOKEN_SUFFIX },
  { file: 'rust-monster.png', prompt: 'A rust monster insectoid with orange-brown carapace, two feathery antennae, and a propeller-like tail' + TOKEN_SUFFIX },
  // New creatures for missing types
  { file: 'pixie.png', prompt: 'A tiny glowing pixie fairy with translucent butterfly wings, mischievous smile, wearing a flower petal dress' + TOKEN_SUFFIX },
  { file: 'sprite.png', prompt: 'A tiny woodland sprite with dragonfly wings, green clothing made of leaves, holding a tiny bow' + TOKEN_SUFFIX },
  { file: 'dryad.png', prompt: 'A beautiful dryad forest spirit with bark-textured skin, green leaf hair, gentle nature-connected expression' + TOKEN_SUFFIX },
  { file: 'green-hag.png', prompt: 'A hideous green hag with warty green skin, long clawed fingers, stringy black hair, evil grin' + TOKEN_SUFFIX },
  { file: 'imp.png', prompt: 'A tiny red imp devil with small horns, bat wings, barbed tail, and a wicked grin' + TOKEN_SUFFIX },
  { file: 'quasit.png', prompt: 'A small demonic quasit with green scaly skin, tiny horns, bat wings, and sharp claws' + TOKEN_SUFFIX },
  { file: 'hell-hound.png', prompt: 'A hell hound with black fur wreathed in flames, glowing red eyes, fire dripping from its jaws' + TOKEN_SUFFIX },
  { file: 'succubus.png', prompt: 'A beautiful but dangerous succubus with bat wings, small horns, dark alluring eyes, elegant dark clothing' + TOKEN_SUFFIX },
  { file: 'barbed-devil.png', prompt: 'A barbed devil covered in sharp spines and barbs, red skin, muscular build, cruel face with horns' + TOKEN_SUFFIX },
  { file: 'animated-armor.png', prompt: 'An empty suit of medieval plate armor floating upright with ghostly blue energy glowing from the joints' + TOKEN_SUFFIX },
  { file: 'flying-sword.png', prompt: 'A magical longsword floating in the air with blue arcane energy swirling around the blade' + TOKEN_SUFFIX },
  { file: 'shield-guardian.png', prompt: 'A large stone and metal shield guardian construct with glowing runes on its chest, protective stance' + TOKEN_SUFFIX },
  { file: 'iron-golem.png', prompt: 'A massive iron golem construct, towering humanoid figure made of riveted iron plates, glowing forge-hot eyes' + TOKEN_SUFFIX },
  { file: 'magma-mephit.png', prompt: 'A small magma mephit elemental creature made of molten rock and fire, flickering flames for wings' + TOKEN_SUFFIX },
  { file: 'fire-elemental.png', prompt: 'A towering fire elemental, humanoid form made entirely of roaring flames, blazing eyes' + TOKEN_SUFFIX },
  { file: 'water-elemental.png', prompt: 'A large water elemental, humanoid form made of swirling blue water, wave-like features' + TOKEN_SUFFIX },
  { file: 'earth-elemental.png', prompt: 'A massive earth elemental, humanoid form made of rock and soil, crystal formations in its body' + TOKEN_SUFFIX },
  { file: 'air-elemental.png', prompt: 'An air elemental, swirling vortex of wind in a vaguely humanoid shape, lightning crackling within' + TOKEN_SUFFIX },
  { file: 'gray-ooze.png', prompt: 'A grey amorphous ooze puddle creature, semi-transparent with dissolved objects visible within' + TOKEN_SUFFIX },
  { file: 'black-pudding.png', prompt: 'A large black pudding ooze, dark amorphous blob with acidic tendrils reaching outward' + TOKEN_SUFFIX },
];

async function generate(prompt) {
  const resp = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }
  throw new Error('No image in response');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const mode = process.argv[2] || 'all'; // 'maps', 'tokens', or 'all'
  const forceRegenerate = process.argv.includes('--force');

  let items = [];
  if (mode === 'maps' || mode === 'all') {
    items.push(...MAPS.map(m => ({ ...m, dir: MAP_DIR, type: 'map' })));
  }
  if (mode === 'tokens' || mode === 'all') {
    items.push(...CREATURES.map(c => ({ ...c, dir: TOKEN_DIR, type: 'token' })));
  }

  console.log(`Regenerating ${items.length} images using Nano Banana Pro...`);
  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fp = path.join(item.dir, item.file);

    if (!forceRegenerate && fs.existsSync(fp)) {
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${items.length}] ${item.type}: ${item.file}...`);
    try {
      const img = await generate(item.prompt);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
      success++;
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
      failed++;
    }
    // Rate limit - 2 seconds between requests
    if (i < items.length - 1) await sleep(2000);
  }

  console.log(`\nDone: ${success} generated, ${skipped} skipped, ${failed} failed`);
}

main();
