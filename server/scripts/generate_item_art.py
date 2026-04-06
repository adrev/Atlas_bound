#!/usr/bin/env python3
"""
Generate item/loot art locally using SDXL Turbo on Apple Silicon (MPS).
Same approach as creature tokens — completely free, runs on your GPU.

Usage:
  cd /path/to/dnd-vtt
  source .venv/bin/activate
  python server/scripts/generate_item_art.py
  python server/scripts/generate_item_art.py --limit 50
  python server/scripts/generate_item_art.py --type Currency
  python server/scripts/generate_item_art.py --dry-run
"""
import argparse
import os
import re
import sys
import time
import sqlite3

parser = argparse.ArgumentParser(description="Generate item art locally")
parser.add_argument("--limit", type=int, default=9999, help="Max images to generate")
parser.add_argument("--type", type=str, default=None, help="Filter by item type (e.g. 'Weapon', 'Currency')")
parser.add_argument("--source", type=str, default=None, help="Filter by source (e.g. 'PHB Equipment', '5e Core Rules')")
parser.add_argument("--dry-run", action="store_true", help="Preview prompts only")
parser.add_argument("--size", type=int, default=512, help="Image size in pixels")
args = parser.parse_args()

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "server", "data", "dnd-vtt.db")
ITEMS_DIR = os.path.join(PROJECT_ROOT, "server", "uploads", "items")
os.makedirs(ITEMS_DIR, exist_ok=True)

# --- Prompt engineering per item type ---
TYPE_PROMPTS = {
    # Weapons
    "Weapon": "a fantasy weapon, detailed metalwork, ornate craftsmanship",
    "Simple Melee Weapon": "a simple melee weapon, practical design, worn leather grip",
    "Simple Ranged Weapon": "a simple ranged weapon, practical design, wooden and string",
    "Martial Melee Weapon": "a martial melee weapon, fine steel blade, detailed craftsmanship",
    "Martial Ranged Weapon": "a martial ranged weapon, finely crafted, polished wood and metal",
    # Armor
    "Armor": "a suit of fantasy armor, detailed metalwork, imposing",
    "Light Armor": "light leather armor, supple and flexible, dark tones",
    "Medium Armor": "medium armor with chainmail and leather, sturdy",
    "Heavy Armor": "heavy plate armor, imposing steel plates, ornate",
    "Shield": "a sturdy shield, wooden with metal reinforcement, heraldic design",
    # Magic items
    "Wondrous item": "a glowing magical artifact, mystical aura, enchanted",
    "Wondrous Item": "a glowing magical artifact, mystical aura, enchanted",
    "Ring": "a magical ring, gemstone set in ornate band, faint magical glow",
    "Potion": "a glass potion bottle with colorful swirling liquid, cork stopper, magical glow",
    "Staff": "an ornate magical staff, carved wood with crystal or gem tip, arcane runes",
    "Wand": "a slender magical wand, polished wood with gem tip, sparkling energy",
    "Rod": "a magical rod, ornate metalwork, glowing runes along the shaft",
    "Scroll": "a rolled magical scroll, parchment with glowing arcane text, wax seal",
    "Ammunition": "a bundle of magical ammunition, arrows or bolts with glowing tips",
    # Treasure
    "Currency": "a pile of shining coins, metallic luster, treasure",
    "Treasure": "a precious gemstone or art object, glittering, valuable treasure",
    # Gear
    "Adventuring Gear": "adventuring equipment, practical and well-used, leather and metal",
}

RARITY_MODIFIERS = {
    "common": "",
    "uncommon": "faintly glowing green aura, ",
    "rare": "glowing blue magical aura, ",
    "very rare": "intense purple magical aura, powerful enchantment, ",
    "legendary": "radiant golden-orange aura, legendary power, ",
    "artifact": "overwhelming cosmic energy, ancient and terrifying power, ",
}

PROMPT_SUFFIX = ", circular icon, dark fantasy style, detailed illustration, dark background, centered composition, item icon art, no text, no hands, no characters"
NEGATIVE = "text, watermark, words, letters, blurry, low quality, deformed, white background, bright, cartoon, anime, person, hand, fingers, character, face"


def build_prompt(name, item_type, rarity):
    # Clean up name for prompt
    clean_name = re.sub(r'\s*\(.*?\)\s*', ' ', name).strip()

    type_desc = TYPE_PROMPTS.get(item_type, "a fantasy item, magical")

    # Normalize rarity to lowercase for lookup
    rarity_mod = RARITY_MODIFIERS.get(rarity.lower().strip(), "")

    return f"{clean_name}, {rarity_mod}{type_desc}{PROMPT_SUFFIX}"


def slug_to_filename(slug):
    return re.sub(r"[^a-z0-9-]", "", slug.lower())


# --- DB ---
def get_pending_items(limit, type_filter=None, source_filter=None):
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT slug, name, type, rarity FROM compendium_items WHERE token_image_source = 'none' OR token_image_source IS NULL"
    params = []
    if type_filter:
        query += " AND type LIKE ?"
        params.append(f"%{type_filter}%")
    if source_filter:
        query += " AND source = ?"
        params.append(source_filter)
    query += " ORDER BY CASE source WHEN 'PHB Equipment' THEN 0 WHEN '5e Core Rules' THEN 1 ELSE 2 END, name ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [{"slug": r[0], "name": r[1], "type": r[2], "rarity": r[3]} for r in rows]


def count_remaining(type_filter=None, source_filter=None):
    conn = sqlite3.connect(DB_PATH)
    query = "SELECT COUNT(*) FROM compendium_items WHERE token_image_source = 'none' OR token_image_source IS NULL"
    params = []
    if type_filter:
        query += " AND type LIKE ?"
        params.append(f"%{type_filter}%")
    if source_filter:
        query += " AND source = ?"
        params.append(source_filter)
    count = conn.execute(query, params).fetchone()[0]
    conn.close()
    return count


def mark_generated(slug):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE compendium_items SET token_image_source = 'ai-generated' WHERE slug = ?", (slug,))
    conn.commit()
    conn.close()


# --- Main ---
def main():
    items = get_pending_items(args.limit, args.type, args.source)
    remaining = count_remaining(args.type, args.source)

    print(f"=== Local Item Art Generator (SDXL on MPS) ===")
    print(f"Pending: {len(items)} this run, {remaining} total remaining")
    print(f"Size: {args.size}px")
    print()

    if not items:
        print("Nothing to generate!")
        return

    if args.dry_run:
        for i, item in enumerate(items[:20]):
            prompt = build_prompt(item["name"], item["type"], item["rarity"])
            print(f"[{i+1}] {item['name']} ({item['type']}, {item['rarity']})")
            print(f"    {prompt[:120]}...")
            print()
        if len(items) > 20:
            print(f"... and {len(items) - 20} more")
        return

    print("Loading SDXL Turbo model...")
    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}")

    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sdxl-turbo",
        torch_dtype=torch.float16 if device == "mps" else torch.float32,
        variant="fp16" if device == "mps" else None,
    )
    pipe = pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    print(f"Model loaded! Starting generation...\n")

    success = 0
    failed = 0

    for i, item in enumerate(items):
        filename = slug_to_filename(item["slug"]) + ".png"
        filepath = os.path.join(ITEMS_DIR, filename)

        if os.path.exists(filepath):
            print(f"[{i+1}/{len(items)}] {item['name']} — exists, skipping")
            mark_generated(item["slug"])
            success += 1
            continue

        prompt = build_prompt(item["name"], item["type"], item["rarity"])
        print(f"[{i+1}/{len(items)}] {item['name']} ({item['type']}, {item['rarity']})")

        try:
            start = time.time()
            result = pipe(
                prompt=prompt,
                negative_prompt=NEGATIVE,
                num_inference_steps=4,
                guidance_scale=0.0,
                width=args.size,
                height=args.size,
            )
            image = result.images[0]
            image.save(filepath)
            elapsed = time.time() - start
            fsize = os.path.getsize(filepath) / 1024
            mark_generated(item["slug"])
            success += 1
            print(f"    Saved ({fsize:.0f} KB, {elapsed:.1f}s)")
        except Exception as e:
            failed += 1
            print(f"    FAILED: {e}")

    print(f"\n=== Done: {success} generated, {failed} failed ===")
    print(f"Remaining: {remaining - success} items still need art")


if __name__ == "__main__":
    main()
