"""Read Nova Lands save files (Worlds/<version>/WORLDnnn.dat).

Usage:
  python save_reader.py <WORLD.dat> [out.json]          decode a save to JSON
  python save_reader.py --diff <old.dat> <new.dat>      measure real production speed between two saves

Save format: base64 -> bzip2 -> binary tree. Each value is a 1-byte tag followed by:
  1 list (int32 count, values) | 2 dict (int32 count, (string key, value)...) | 3 string
  4 int32 | 5 int64 | 6 bool (1 byte) | 7 float32 | 8 float64
Strings are 7-bit-length-prefixed UTF-8 (.NET BinaryWriter style).
"""
import base64
import bz2
import json
import os
import struct
import sys


def decode(path):
    b = bz2.decompress(base64.b64decode(open(path, "rb").read()))
    p = 0

    def u7():
        nonlocal p
        r = s = 0
        while True:
            c = b[p]
            p += 1
            r |= (c & 0x7F) << s
            s += 7
            if not c & 0x80:
                return r

    def string():
        nonlocal p
        n = u7()
        v = b[p:p + n].decode("utf-8", "replace")
        p += n
        return v

    def unpack(fmt):
        nonlocal p
        v = struct.unpack_from(fmt, b, p)[0]
        p += struct.calcsize(fmt)
        return v

    def val():
        nonlocal p
        t = b[p]
        p += 1
        if t == 1:
            return [val() for _ in range(unpack("<i"))]
        if t == 2:
            return {string(): val() for _ in range(unpack("<i"))}
        if t == 3:
            return string()
        if t == 4:
            return unpack("<i")
        if t == 5:
            return unpack("<q")
        if t == 6:
            return bool(unpack("<B"))
        if t == 7:
            return unpack("<f")
        if t == 8:
            return unpack("<d")
        raise ValueError(f"unknown tag {t} at offset {p - 1}")

    return val()


def buildings(save):
    return [b for layer in save["World"]["World"].values() for area in layer for b in area.get("Buildings", [])]


def diff(old_path, new_path, gamedata_path):
    g = json.load(open(gamedata_path, encoding="utf-8"))
    B = {b["id"]: b for b in g["buildings"]}
    R = {r["id"]: r for r in g["recipes"]}
    a, b = decode(old_path), decode(new_path)
    dt = {k: b["Time"][k] - a["Time"][k] for k in ("GameTime", "GameTimeScaled")}
    print("time delta:", dt)
    old = {x["Id"]: x for x in buildings(a)}
    for x in buildings(b):
        y = old.get(x["Id"])
        if not y or "CurrentProductionTime" not in x or x.get("RecipeId") is None or x.get("RecipeId") != y.get("RecipeId"):
            continue
        r = R.get(x["RecipeId"])
        progress = x["CurrentProductionTime"] - y["CurrentProductionTime"]
        if not r or progress <= 0:  # finished a cycle in between, or idle
            continue
        lub = (x.get("Lubricant") or {}).get("CurrentDuration", 0) > 0
        bld = B.get(x["BuildingId"], {})
        print(f"{bld.get('key', x['BuildingId']):26} {r['key']:34} progress {progress:8.2f}  "
              f"per GameTime/1000: {progress / dt['GameTime'] * 1000:.3f}  "
              f"per GameTimeScaled/1000: {progress / dt['GameTimeScaled'] * 1000:.3f}"
              f"  productionSpeed={bld.get('productionSpeed')}{'  LUBRICANT' if lub else ''}")

    # farm plots: crop growth / renewable regrowth, water and fertilizer timers
    for x in buildings(b):
        y = old.get(x["Id"])
        if not y or "Crop" not in x or not isinstance(x.get("Crop"), dict) or not isinstance(y.get("Crop"), dict):
            continue
        cx, cy = x["Crop"], y["Crop"]
        if cx.get("Id") != cy.get("Id"):
            print(f"farm {x['Id']}: crop replaced")
            continue
        print(f"farm {x['Id']} {cx.get('Name'):26} CurrentTime {cy.get('CurrentTime')} -> {cx.get('CurrentTime')}  "
              f"res {cy.get('CurrentResources')} -> {cx.get('CurrentResources')}  "
              f"water {y.get('Water')} -> {x.get('Water')}  fert {y.get('Fertilizer')} -> {x.get('Fertilizer')}")


if __name__ == "__main__":
    if sys.argv[1] == "--diff":
        here = os.path.dirname(os.path.abspath(__file__))
        diff(sys.argv[2], sys.argv[3], os.path.join(here, "..", "data", "gamedata.json"))
    else:
        data = decode(sys.argv[1])
        out = open(sys.argv[2], "w", encoding="utf-8") if len(sys.argv) > 2 else sys.stdout
        json.dump(data, out, ensure_ascii=False, indent=1)
