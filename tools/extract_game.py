"""Dump Nova Lands game data (IL2CPP Unity build) to raw JSON.

Usage: python extract_game.py "<Nova Lands install dir>" <out_dir>

Typetrees are stripped from the build, so field layouts are regenerated from
GameAssembly.dll + global-metadata.dat via TypeTreeGeneratorAPI. Every
Assembly-CSharp MonoBehaviour whose class has an *Id field (or is listed in
EXTRA) is written to <out_dir>/cls_<Class>.json with PPtrs resolved to
"<file>:<pathId>" keys.

A building's footprint is its `placementCollider` (a BoxCollider2D on a child GameObject); it is attached to
the dumped object as `_placement` = {size, offset, position}: collider size/offset plus the collider object's
position relative to the building (summed local positions up the Transform chain).
"""
import collections
import json
import os
import sys

import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
from UnityPy.helpers.TypeTreeNode import TypeTreeNode

UNITY_VERSION = "2022.2.8f1"
FALLBACK_BASE, FALLBACK_UPTO = "BaseResourceScriptableObject", "sprite"
ASSEMBLY = "Assembly-CSharp"
COLLIDERS = {"BoxCollider2D", "CircleCollider2D", "PolygonCollider2D", "CapsuleCollider2D"}
ID_FIELDS = {"resourceId", "buildingId", "recipeId", "skillId", "researchId", "upgradeId"}
EXTRA = {"RecipesList", "ResourcesList", "GemOverclockBuilding", "FarmPlotBuilding", "AdvancedFarmPlotBuilding",
         "CropBuilding", "ResearchDescriptor", "PlayerUpgradeScriptableObject", "WorldBiome", "AnimalBarnBuilding",
         "HiveBurrow", "TimeProductionBurrow",
         # creatures: animal barn production (food -> output recipes)
         "BaseConsumerCreature", "BaseCollectorCreature", "ArmedCreature", "QueenBeeCreature", "BasePet"}


def main(root, out):
    os.makedirs(out, exist_ok=True)
    env = UnityPy.load(os.path.join(root, "Nova Lands_Data"))
    gen = TypeTreeGenerator(UNITY_VERSION)
    gen.load_local_game(root)

    node_cache, wanted_cache = {}, {}

    def schema(full):
        # get_nodes() (raw) is broken in TypeTreeGeneratorAPI; the JSON variant works.
        if full not in node_cache:
            try:
                node_cache[full] = json.loads(gen.get_nodes_as_json(ASSEMBLY, full))
            except Exception:
                node_cache[full] = None
        return node_cache[full]

    def wanted(full):
        if full not in wanted_cache:
            js = schema(full)
            wanted_cache[full] = js is not None and (
                full in EXTRA or any(n["m_Level"] == 1 and n["m_Name"] in ID_FIELDS for n in js))
        return wanted_cache[full]

    def nodes(full, upto=None):
        # The generator misses the align flag on m_Enabled, which shifts m_Script by 3 bytes.
        js = schema(full)
        if upto:  # keep fields up to and including level-1 field `upto` (with its children)
            cut = next(i for i, n in enumerate(js) if n["m_Level"] == 1 and n["m_Name"] == upto)
            end = next((i for i in range(cut + 1, len(js)) if js[i]["m_Level"] <= 1), len(js))
            js = js[:end]
        return TypeTreeNode.from_list([
            TypeTreeNode(n["m_Level"], n["m_Type"], n["m_Name"], 0, 0,
                         m_MetaFlag=n["m_MetaFlag"] | (0x4000 if n["m_Level"] == 1 and n["m_Name"] == "m_Enabled" else 0))
            for n in js])

    def key_of(af, fid, pid):
        if pid == 0:
            return None
        if fid == 0:
            return f"{af.name}:{pid}"
        if fid - 1 >= len(af.externals):
            return f"?{fid}:{pid}"
        return f"{os.path.basename(af.externals[fid - 1].path.replace(chr(92), '/'))}:{pid}"

    def resolve(x, af):
        if isinstance(x, dict):
            if set(x) == {"m_FileID", "m_PathID"}:
                return key_of(af, x["m_FileID"], x["m_PathID"])
            return {k: resolve(v, af) for k, v in x.items()}
        if isinstance(x, list):
            return [resolve(v, af) for v in x]
        return x

    res, errs, go_names = collections.defaultdict(list), collections.Counter(), {}
    colliders, transforms = {}, {}  # collider key -> fields; GameObject key -> (localPosition, localScale, parent go)
    tr_by_key = {}
    for obj in env.objects:
        if obj.type.name in COLLIDERS:
            try:
                colliders[f"{obj.assets_file.name}:{obj.path_id}"] = (obj.type.name, resolve(obj.read_typetree(), obj.assets_file))
            except Exception:
                pass
            continue
        if obj.type.name == "Transform":
            try:
                t = resolve(obj.read_typetree(), obj.assets_file)
                tr_by_key[f"{obj.assets_file.name}:{obj.path_id}"] = t
                transforms[t["m_GameObject"]] = t
            except Exception:
                pass
            continue
        if obj.type.name == "GameObject":
            try:
                go_names[f"{obj.assets_file.name}:{obj.path_id}"] = obj.read().m_Name
            except Exception:
                pass
            continue
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            sc = obj.read(check_read=False).m_Script.read()
        except Exception:
            continue
        if sc.m_AssemblyName.replace(".dll", "") != ASSEMBLY:
            continue
        full = (sc.m_Namespace + "." if sc.m_Namespace else "") + sc.m_ClassName
        if not wanted(full):
            continue
        try:
            t = resolve(obj.read_typetree(nodes=nodes(full)), obj.assets_file)
        except Exception as e:
            # Some subclasses fail to generate correctly; read just the leading base fields (name + id).
            try:
                t = resolve(obj.read_typetree(nodes=nodes(FALLBACK_BASE, FALLBACK_UPTO), check_read=False),
                            obj.assets_file)
                t["_partial"] = True
            except Exception:
                errs[f"{full}: {type(e).__name__} {e}"[:160]] += 1
                continue
            errs[f"{full}: partial (base fields only)"] += 1
        t["_key"], t["_class"] = f"{obj.assets_file.name}:{obj.path_id}", full
        res[full].append(t)

    def placement(it):
        kind, c = colliders.get(it.get("placementCollider"), (None, None))
        if not c:
            return None
        if kind == "BoxCollider2D":
            size = [c["m_Size"]["x"], c["m_Size"]["y"]]
        elif kind == "CircleCollider2D":
            size = [2 * c["m_Radius"], 2 * c["m_Radius"]]
        else:
            return {"kind": kind}
        # collider object position relative to the building root (rotation ignored)
        pos, t = [0.0, 0.0], transforms.get(c["m_GameObject"])
        root = it.get("m_GameObject")
        for _ in range(16):
            if not t or t["m_GameObject"] == root:
                break
            sc = t["m_LocalScale"]
            size = [size[0] * abs(sc["x"]), size[1] * abs(sc["y"])]
            pos = [pos[0] * sc["x"] + t["m_LocalPosition"]["x"], pos[1] * sc["y"] + t["m_LocalPosition"]["y"]]
            t = tr_by_key.get(t["m_Father"])
        return {"kind": kind, "size": size, "offset": [c["m_Offset"]["x"], c["m_Offset"]["y"]], "position": pos}

    for cls, items in res.items():
        for it in items:
            if it.get("m_GameObject"):
                it["_goName"] = go_names.get(it["m_GameObject"])
            if it.get("placementCollider"):
                it["_placement"] = placement(it)
        with open(os.path.join(out, f"cls_{cls}.json"), "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=1, default=str)
    print(f"dumped {sum(map(len, res.values()))} objects in {len(res)} classes")
    for e, n in errs.most_common():
        print(n, e)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
