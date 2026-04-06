#!/usr/bin/env python3
"""Generate battle map images for D&D VTT using Google Gemini Imagen API."""

import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_KEY = os.environ.get("GEMINI_API_KEY", "REDACTED_API_KEY")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "client", "public", "maps")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Gemini Imagen endpoint
BASE_URL = f"https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key={API_KEY}"

MAPS = [
    {
        "filename": "goblin-camp.png",
        "prompt": "Top-down battle map of a forest clearing with a goblin camp, scattered makeshift tents made of animal hides, a central campfire with orange glow, wooden spikes around the perimeter, fallen logs and rocks for cover, dirt paths between tents, dark green pine forest surrounding the clearing, warm firelight illuminating the center, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "underdark-cavern.png",
        "prompt": "Top-down battle map of a vast underground Underdark cavern, dark purple and blue stone walls, bioluminescent fungi and mushrooms glowing cyan and teal, pools of glowing blue water, stalactite shadows, narrow stone bridges over dark chasms, scattered crystals, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "druid-grove.png",
        "prompt": "Top-down battle map of a sacred druid grove, ancient stone circle with moss-covered standing stones, massive ancient oak trees with gnarled roots, carpet of wildflowers and ferns, a small clear stream, soft dappled sunlight, natural stone altar in center, fairy lights and fireflies, lush green and gold colors, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "moonrise-towers.png",
        "prompt": "Top-down battle map of a dark gothic fortress courtyard, cracked stone floor with arcane symbols, shadowy towers casting long shadows, iron gates and portcullis, dark purple banners, eerie green magical torches, rubble and broken columns, central dark altar, ominous atmosphere, Baldur's Gate 3 inspired, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "nautiloid-wreck.png",
        "prompt": "Top-down battle map of a crashed mind flayer nautiloid ship, organic alien architecture with curved ribbed walls in purple and dark red, bio-mechanical corridors, pulsing tentacle-like structures, burning wreckage, strange organic pods, debris scattered around crash site, otherworldly atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "grymforge.png",
        "prompt": "Top-down battle map of an ancient dwarven forge complex, massive stone architecture with carved dwarven runes, channels of flowing molten lava glowing orange and red, stone bridges over lava rivers, enormous anvils and forging stations, warm orange and red lighting contrasting with cool grey stone, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "forest-road-ambush.png",
        "prompt": "Top-down battle map of a narrow forest road perfect for an ambush, dirt path winding through dense woodland, fallen trees blocking the road, thick bushes providing cover, an overturned merchant cart, tall pine and oak trees casting shadows, morning mist, realistic forest floor with leaves and roots, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "16:9",
    },
    {
        "filename": "zhentarim-hideout.png",
        "prompt": "Top-down battle map of an underground smuggler's den, hewn stone rooms connected by narrow corridors, central meeting room with large table, crates and barrels of stolen goods, dim torchlight, weapon racks and stolen treasure, small underground dock at one edge, criminal underworld atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "elfsong-tavern.png",
        "prompt": "Top-down battle map of a cozy fantasy tavern interior, warm wooden floors and walls, long bar counter with stools, round tables and chairs, large stone fireplace with fire, stairs to second floor balcony, kegs and bottles behind bar, warm golden candlelight, small stage area, cozy inviting atmosphere, Baldur's Gate inspired, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "last-light-inn.png",
        "prompt": "Top-down battle map of a fortified roadside inn, two-story building with stone walls, main common room with fireplace and dining tables, bar area, guest rooms with beds, attached stable for horses, small courtyard with well, defensive wooden palisade, warm interior lighting, safe haven atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "cathedral-lathander.png",
        "prompt": "Top-down battle map of a grand cathedral interior, polished marble floors with mosaic patterns, rows of wooden pews leading to ornate golden altar, stained glass windows casting colorful light on floor, stone pillars, side chapels with prayer alcoves, candelabras and holy symbols, warm golden light, divine sacred atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "wine-cellar.png",
        "prompt": "Top-down battle map of a medieval wine cellar, stone brick walls and arched ceiling supports, rows of large wooden wine barrels, wooden crates, narrow staircase leading up, cobblestone floor with puddles, dim lantern light, spider webs, tight corridors between barrel rows, cool damp atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "4:3",
    },
    {
        "filename": "apothecary-shop.png",
        "prompt": "Top-down battle map of a cluttered fantasy apothecary shop, wooden shelving with colorful potion bottles, central worktable with alchemical equipment, dried herbs hanging from ceiling, small counter near entrance, back room with storage, bubbling cauldron, magical ingredients glowing faintly, cozy mysterious atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "camp-long-rest.png",
        "prompt": "Top-down battle map of a wilderness campsite at night, warm central campfire with orange glow, bedrolls in a circle around fire, small tent, backpacks and adventuring gear, cooking pot over fire, fallen log seating, surrounding dark forest, starry night sky reflected in nearby stream, warm safe circle in wilderness darkness, peaceful atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
    {
        "filename": "merchant-quarter.png",
        "prompt": "Top-down battle map of a medieval town square marketplace, cobblestone streets and central stone fountain, colorful market stalls with fabric awnings, shops lining edges, barrels and crates of goods, town notice board, flower planters and street lanterns, narrow alleyways between buildings, warm afternoon sunlight, lively commercial atmosphere, fantasy RPG style, top-down view, battle map, grid-ready, no text, no UI, high detail, digital painting",
        "ratio": "1:1",
    },
]


def generate_image(prompt: str, aspect_ratio: str = "1:1") -> bytes | None:
    """Call Gemini Imagen API to generate an image."""
    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {
            "sampleCount": 1,
            "aspectRatio": aspect_ratio,
        },
    }

    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode())
            predictions = body.get("predictions", [])
            if predictions:
                b64 = predictions[0].get("bytesBase64Encoded")
                if b64:
                    return base64.b64decode(b64)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        print(f"  HTTP {e.code}: {error_body[:300]}")
    except Exception as e:
        print(f"  Error: {e}")

    return None


def main():
    print(f"Generating {len(MAPS)} battle maps using Gemini Imagen...")
    print(f"Output: {OUTPUT_DIR}\n")

    success = 0
    for i, m in enumerate(MAPS):
        filepath = os.path.join(OUTPUT_DIR, m["filename"])
        if os.path.exists(filepath):
            print(f"[{i+1}/{len(MAPS)}] {m['filename']} - already exists, skipping")
            success += 1
            continue

        print(f"[{i+1}/{len(MAPS)}] Generating {m['filename']}...")
        img_data = generate_image(m["prompt"], m["ratio"])

        if img_data:
            with open(filepath, "wb") as f:
                f.write(img_data)
            print(f"  Saved ({len(img_data) // 1024} KB)")
            success += 1
        else:
            print(f"  FAILED")

        # Rate limit: wait between requests
        if i < len(MAPS) - 1:
            time.sleep(3)

    print(f"\nDone: {success}/{len(MAPS)} maps generated")


if __name__ == "__main__":
    main()
