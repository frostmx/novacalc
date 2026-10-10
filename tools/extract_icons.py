"""Extract item and building icons from the game into one sprite atlas.

Usage: python extract_icons.py "<Nova Lands install dir>" <raw_dir> <out_dir>

Writes <out_dir>/icons.png (CELL×CELL cells, COLS per row) and <out_dir>/icons.json:
{"cell": CELL, "cols": COLS, "items": {resourceId: index}, "buildings": {buildingId: index}}.
Items use their `sprite`; buildings their UI icon (`uiIcon` SpriteRenderer), falling back to the world `sprite`.
Every building in data/gamedata.json gets an icon when it has a sprite.
"""
import glob
import json
import os
import sys

import UnityPy
from PIL import Image

CELL = 64
COLS = 16


def main(root, raw_dir, out_dir):
    gamedata = json.load(open(os.path.join(out_dir, "gamedata.json"), encoding="utf-8"))
    wanted_buildings = {b["id"] for b in gamedata["buildings"]}  # all: the architect shows every placed building

    # which sprite / renderer each item and building points to ("file:pathId")
    item_refs, building_refs = {}, {}
    for f in glob.glob(os.path.join(raw_dir, "cls_*.json")):
        for o in json.load(open(f, encoding="utf-8")):
            if "resourceId" in o and o.get("sprite"):
                item_refs[o["resourceId"]] = o["sprite"]
            if o.get("buildingId") in wanted_buildings:
                refs = [r for r in (o.get("uiIcon"), o.get("sprite")) if r]
                if refs:
                    building_refs.setdefault(o["buildingId"], refs)

    needed = set(item_refs.values()) | {r for refs in building_refs.values() for r in refs}
    env = UnityPy.load(os.path.join(root, "Nova Lands_Data"))
    objs = {}
    for obj in env.objects:
        key = f"{obj.assets_file.name}:{obj.path_id}"
        if key in needed or obj.type.name == "Sprite":
            objs[key] = obj

    def sprite_image(ref):
        obj = objs.get(ref)
        if obj is None:
            return None
        data = obj.read()
        if obj.type.name == "SpriteRenderer":
            sp = data.m_Sprite
            if not sp or not sp.m_PathID:
                return None
            data = sp.read()
        elif obj.type.name != "Sprite":
            return None
        img = data.image.convert("RGBA")
        box = img.getbbox()
        return img.crop(box) if box else None

    def fit(img):
        # pixel art: grow small sprites by a whole factor without smoothing, shrink big ones smoothly
        k = (CELL - 4) // max(img.width, img.height)
        if k >= 1:
            img = img.resize((img.width * k, img.height * k), Image.NEAREST)
        else:
            img = img.copy()
            img.thumbnail((CELL - 4, CELL - 4), Image.LANCZOS)
        cell = Image.new("RGBA", (CELL, CELL))
        cell.paste(img, ((CELL - img.width) // 2, (CELL - img.height) // 2), img)
        return cell

    cells, index = [], {"items": {}, "buildings": {}}
    for kind, refs_by_id in (("items", {k: [v] for k, v in item_refs.items()}), ("buildings", building_refs)):
        for oid, refs in sorted(refs_by_id.items()):
            img = next((im for im in map(sprite_image, refs) if im is not None), None)
            if img is None:
                continue
            index[kind][oid] = len(cells)
            cells.append(fit(img))

    rows = (len(cells) + COLS - 1) // COLS
    atlas = Image.new("RGBA", (COLS * CELL, rows * CELL))
    for i, c in enumerate(cells):
        atlas.paste(c, ((i % COLS) * CELL, (i // COLS) * CELL))
    atlas.save(os.path.join(out_dir, "icons.png"), optimize=True)
    with open(os.path.join(out_dir, "icons.json"), "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "cols": COLS, **index}, f)
    missing_items = sorted(set(i["id"] for i in gamedata["items"]) - set(index["items"]))
    print(f"{len(index['items'])} item icons, {len(index['buildings'])} building icons -> {atlas.size}; "
          f"items without icon: {missing_items}; buildings without icon: {sorted(wanted_buildings - set(index['buildings']))}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
