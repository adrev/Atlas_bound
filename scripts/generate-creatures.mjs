import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = 'AIzaSyAX4yOSVOghzkMLG26tKdDUXnjqqnDINYc';
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${API_KEY}`;
const OUT = path.join(__dirname, '..', 'client', 'public', 'tokens');
fs.mkdirSync(OUT, { recursive: true });

const SUFFIX = ', circular token portrait, dark fantasy style, detailed illustration, dark background, centered face/body, D&D character token, no text, no border decorations';

const CREATURES = [
  // Low level (1-3)
  { filename: 'rat.png', prompt: 'A giant brown rat with glowing red eyes, snarling, matted fur' + SUFFIX },
  { filename: 'wolf.png', prompt: 'A fierce grey wolf with yellow eyes, growling, sharp teeth showing' + SUFFIX },
  { filename: 'goblin.png', prompt: 'A green-skinned goblin with pointed ears, wearing leather scraps, holding a rusty dagger, sneering expression' + SUFFIX },
  { filename: 'kobold.png', prompt: 'A small red-scaled kobold with yellow eyes, wearing a crude helmet, holding a tiny spear' + SUFFIX },
  { filename: 'skeleton.png', prompt: 'An animated skeleton warrior with glowing blue eye sockets, wearing rusted armor fragments, holding a sword' + SUFFIX },
  { filename: 'zombie.png', prompt: 'A shambling undead zombie with rotting green-grey skin, torn clothing, empty milky eyes, reaching out' + SUFFIX },
  { filename: 'bandit.png', prompt: 'A rugged human bandit with a scar across face, wearing a dark hood and leather armor, menacing look' + SUFFIX },
  { filename: 'giant-spider.png', prompt: 'A large black spider with eight glowing green eyes, hairy legs, dripping fangs, menacing arachnid' + SUFFIX },

  // Medium level (4-7)
  { filename: 'orc.png', prompt: 'A muscular green-skinned orc warrior with tusks, tribal war paint, heavy iron armor, wielding a battle axe' + SUFFIX },
  { filename: 'gnoll.png', prompt: 'A fierce hyena-headed gnoll with spotted brown fur, wearing bone armor, snarling with sharp teeth' + SUFFIX },
  { filename: 'bugbear.png', prompt: 'A large hairy bugbear with orange-brown fur, small eyes, wearing patchwork armor, carrying a morningstar' + SUFFIX },
  { filename: 'ogre.png', prompt: 'A massive fat ogre with grey-green skin, small brain, wearing animal hide loincloth, carrying a huge wooden club' + SUFFIX },
  { filename: 'owlbear.png', prompt: 'A fearsome owlbear creature with an owl head and bear body, brown feathers and fur, sharp beak and claws' + SUFFIX },
  { filename: 'minotaur.png', prompt: 'A powerful minotaur with a bull head and muscular human body, large curved horns, red eyes, holding a great axe' + SUFFIX },
  { filename: 'basilisk.png', prompt: 'A eight-legged reptilian basilisk with grey-green scales, glowing yellow eyes that can petrify, heavy body' + SUFFIX },

  // High level (8-12)
  { filename: 'troll.png', prompt: 'A tall lanky green troll with long arms, sharp claws, regenerating wounds visible, wild eyes, hunched posture' + SUFFIX },
  { filename: 'manticore.png', prompt: 'A manticore with a lion body, bat wings, and a scorpion tail with spikes, human-like face with fangs' + SUFFIX },
  { filename: 'griffon.png', prompt: 'A majestic griffon with an eagle head and wings and a lion body, golden feathers, fierce golden eyes' + SUFFIX },
  { filename: 'displacer-beast.png', prompt: 'A panther-like displacer beast with six legs and two tentacles on its back, dark blue-black fur, glowing eyes' + SUFFIX },
  { filename: 'hook-horror.png', prompt: 'A hulking hook horror with a vulture-like head, grey exoskeleton, massive hook-shaped claws for hands' + SUFFIX },

  // Very high level (13+)
  { filename: 'mind-flayer.png', prompt: 'A mind flayer illithid with purple skin, four facial tentacles, bulbous head, wearing elegant dark robes, glowing eyes' + SUFFIX },
  { filename: 'beholder.png', prompt: 'A floating beholder aberration, large central eye, many eye stalks on top, wide mouth with sharp teeth, round body' + SUFFIX },
  { filename: 'young-red-dragon.png', prompt: 'A young red dragon with crimson scales, wings spread, horned head, breathing orange fire, fierce and powerful' + SUFFIX },
  { filename: 'adult-red-dragon.png', prompt: 'A massive ancient red dragon with dark crimson scales, enormous wings, crown of horns, glowing eyes, terrifying' + SUFFIX },
  { filename: 'lich.png', prompt: 'An undead lich with a skeletal face, glowing green eyes in hollow sockets, wearing ornate dark purple robes, holding a staff with a glowing gem, crown on skull' + SUFFIX },

  // NPCs
  { filename: 'guard.png', prompt: 'A human town guard in chainmail armor with a city tabard, holding a spear and shield, stern expression' + SUFFIX },
  { filename: 'knight.png', prompt: 'A noble human knight in shining plate armor with a plumed helmet visor up, holding a longsword, heroic' + SUFFIX },
  { filename: 'mage.png', prompt: 'A human wizard with a long grey beard, wearing blue robes with star patterns, holding a glowing magical staff' + SUFFIX },
  { filename: 'assassin.png', prompt: 'A hooded assassin in dark leather armor, face partially hidden by a black mask, dual wielding daggers, shadowy' + SUFFIX },
  { filename: 'bandit-captain.png', prompt: 'A scarred human bandit captain with an eyepatch, wearing studded leather, wielding a cutlass, commanding presence' + SUFFIX },

  // Extra creatures
  { filename: 'gelatinous-cube.png', prompt: 'A transparent gelatinous cube monster, faintly visible square shape, objects and bones floating inside it, ooze creature' + SUFFIX },
  { filename: 'mimic.png', prompt: 'A mimic monster disguised as a wooden treasure chest, with teeth forming around the lid, a long sticky tongue, and one eye peeking out' + SUFFIX },
  { filename: 'rust-monster.png', prompt: 'A rust monster insectoid creature with orange-brown carapace, two feathery antennae, propeller-like tail, lobster-like body' + SUFFIX },
];

async function gen(prompt, ratio = '1:1') {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: ratio } }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t.substring(0, 200)}`);
  }
  const body = await resp.json();
  if (body.predictions?.[0]?.bytesBase64Encoded) {
    return Buffer.from(body.predictions[0].bytesBase64Encoded, 'base64');
  }
  throw new Error('No image data');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Generating ${CREATURES.length} creature token images...`);
  let success = 0;

  for (let i = 0; i < CREATURES.length; i++) {
    const c = CREATURES[i];
    const fp = path.join(OUT, c.filename);
    if (fs.existsSync(fp)) {
      console.log(`[${i + 1}/${CREATURES.length}] ${c.filename} - exists, skipping`);
      success++;
      continue;
    }
    console.log(`[${i + 1}/${CREATURES.length}] ${c.filename}...`);
    try {
      const img = await gen(c.prompt);
      fs.writeFileSync(fp, img);
      console.log(`  OK (${Math.round(img.length / 1024)} KB)`);
      success++;
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
    if (i < CREATURES.length - 1) await sleep(3000);
  }
  console.log(`\nDone: ${success}/${CREATURES.length} creature tokens`);
}

main();
