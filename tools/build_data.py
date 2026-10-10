"""Normalize raw dumps (from extract_game.py) into data/gamedata.json + data/locale/<lang>.json.

Usage: python build_data.py "<Nova Lands install dir>" <raw_dir> <out_dir> [lang ...]

gamedata.json references text only by localization keys (nameKey/descKey, the game's own keys).
Each locale file maps those keys to text, taken from the game's localization; default lang is en.
Packages have no own name key: display name = name(packageOf) + " " + text("PackageResourceSuffix").
"""
import glob
import json
import os
import re
import sys

EXTRA_KEYS = ["PackageResourceSuffix", "PRODUCTION_SPEED_LABEL"]


def load_loc(root, lang):
    """lang is the game's file suffix: en, ru_RU, de, pt_BR, ..."""
    p = os.path.join(root, "Nova Lands_Data", "StreamingAssets", "Localization", f"messages_{lang}.bytes")
    text = open(p, encoding="utf-8-sig").read()
    return json.loads(re.sub(r",(\s*})", r"\1", text))  # game files have trailing commas


def main(root, raw_dir, out_dir, langs):
    en = load_loc(root, "en")
    objs, by_class = {}, {}
    for f in glob.glob(os.path.join(raw_dir, "cls_*.json")):
        for o in json.load(open(f, encoding="utf-8")):
            objs[o["_key"]] = o
            by_class.setdefault(o["_class"], []).append(o)

    def pick(*keys):
        """First key that exists in the English table (else the first, conventional one)."""
        return next((k for k in keys if k and k in en), keys[0])

    def hexcolor(c):
        return "#%02X%02X%02X" % tuple(round(c[k] * 255) for k in "rgb")

    def exact(v):  # positions are multiples of 1/32: keep them exact
        return round(v, 6)

    def clean(v):
        return round(v, 4) if isinstance(v, float) else v

    # --- items ---
    items, item_id = {}, {}
    for o in objs.values():
        if "resourceId" not in o:
            continue
        it = {"id": o["resourceId"], "key": o["m_Name"], "class": o["_class"],
              "category": o.get("itemCategory"), "stack": o.get("maxStackSize")}
        if o.get("encapsulatedResource"):
            it["packageOf"] = o["encapsulatedResource"]
        else:
            it["nameKey"] = f"{o['m_Name']}_RESOURCE_NAME"
            it["descKey"] = f"{o['m_Name']}_RESOURCE_DESC"
        if o.get("_partial"):
            it["partial"] = True
        items[o["_key"]] = it
        item_id[o["_key"]] = o["resourceId"]
    for it in items.values():
        if "packageOf" in it:
            it["packageOf"] = item_id.get(it["packageOf"])

    def stacks(lst):
        return [{"item": item_id.get(p["resource"]), "amount": p["amount"]} for p in lst or [] if p.get("resource")]

    # --- recipes ---
    recipes, recipe_id = {}, {}
    for o in by_class.get("BaseRecipe", []):
        recipes[o["_key"]] = {"id": o["recipeId"], "key": o["m_Name"], "inputs": stacks(o["input"]),
                              "outputs": stacks(o["output"]), "time": clean(o["productionTime"]),
                              "startUnlocked": bool(o["startUnlocked"])}
        recipe_id[o["_key"]] = o["recipeId"]

    # --- buildings ---
    buildings, building_id = [], {}
    for o in objs.values():
        if "buildingId" in o:
            building_id[o["_key"]] = o["buildingId"]
    for o in objs.values():
        if "buildingId" not in o or o.get("isProp"):
            continue
        go = o.get("_goName") or o["m_Name"]
        b = {"id": o["buildingId"], "key": go, "class": o["_class"],
             "nameKey": pick(f"{go}_BUILDING_NAME", o.get("customName") and f"{o['customName']}_BUILDING_NAME"),
             "descKey": pick(f"{go}_BUILDING_DESC", o.get("customName") and f"{o['customName']}_BUILDING_DESC"),
             "cost": stacks(o.get("constructionCost")),
             "energy": clean(o.get("requiredEnergy")) if o.get("consumeEnergy") else 0}
        if "availableRecipes" in o:
            b["recipes"] = [recipe_id[r] for r in o["availableRecipes"] if r in recipe_id
                            and (recipes[r]["inputs"] or recipes[r]["outputs"])]  # skips the Driller's empty one
            b["productionSpeed"] = clean(o.get("productionSpeed"))
            b["lubricant"] = o["_class"].startswith("LubricantEnabled")
        if "producedEnergy" in o:
            b["producedEnergy"] = o["producedEnergy"]
            if o.get("useFuel"):
                b["fuel"] = {"item": item_id.get(o["fuel"]), "duration": clean(o["fuelDuration"])}
        if "maxNumberOfCreatures" in o:
            b["maxCreatures"] = o["maxNumberOfCreatures"]
            b["bonusPerCreature"] = clean(o["productionBonusPerCreature"])
        if o["_class"] == "AdvancedFarmPlotBuilding":
            b["farm"] = {"plots": len(o.get("farmPlots") or [])}
        elif o["_class"] == "FarmPlotBuilding" and not o.get("isInnerFarmPlot"):
            b["farm"] = {"plots": 1}
        # footprint on the island: placementCollider box, centre relative to the building position (world units);
        # placement snaps (position - placementOffset) to the centre of a 0.5 grid cell (checked on saves)
        pl = o.get("_placement") or {}
        if pl.get("size"):
            b["footprint"] = {"w": exact(pl["size"][0]), "h": exact(pl["size"][1]),
                              "x": exact(pl["offset"][0] + pl["position"][0]), "y": exact(pl["offset"][1] + pl["position"][1])}
        po = o.get("placementOffset")
        if po:
            b["placementOffset"] = [exact(po["x"]), exact(po["y"])]
        buildings.append(b)
    # dedupe by id (same prefab can appear in several scenes); prefer the copy with recipes and a footprint
    buildings = list({b["id"]: b for b in sorted(buildings, key=lambda b: ("footprint" in b, len(b.get("recipes", []))))}.values())

    # --- modifiers ---
    def bpairs(lst, *fields):
        return [{"building": building_id.get(p["building"]), **{f: clean(p[f]) for f in fields}} for p in lst or []]

    skills = []
    for o in by_class.get("PlayerSkillDescriptor", []):
        nk = o.get("customNameString") or f"{o['m_Name']}_PLAYER_SKILL_NAME_SUFFIX"
        dk = o.get("customDescString") or f"{o['m_Name']}_PLAYER_SKILL_DESC_SUFFIX"
        s = {"id": o["skillId"], "key": o["m_Name"], "nameKey": nk, "descKey": dk,
             "descValues": [clean(v) for v in o.get("skillLocalizationValues") or []],
             "cost": o["skillPointsCost"], "inTree": bool(o["usedInSkillTree"]),
             "requires": [objs[r]["skillId"] for r in (o["requirement"], o["requirementAdditional"]) if r in objs],
             "speed": bpairs(o["productionBuildingSpeedBonus"], "value"),
             "efficiency": bpairs(o["productionBuildingEfficiencyBonus"], "value"),
             "extraOutput": bpairs(o["productionBuildingProductionBonus"], "value", "chance"),
             "containerSize": bpairs(o["productionContainersSizeBonus"], "value"),
             "solarMultiplier": clean(o["productionSolarPanelEfficiencyMultiplier"])}
        skills.append(s)

    def simple(cls, **fields):
        return [{"item": o["resourceId"], **{k: clean(o[v]) for k, v in fields.items()}} for o in by_class.get(cls, [])]

    gem_groups = [[building_id.get(b) for b in g["group"]]
                  for o in by_class.get("GemOverclockBuilding", []) for g in o["buildingsGroups"]]
    # --- creatures (Animal Barn): each species runs its own food -> output recipe ---
    creatures = []
    for o in by_class.get("BaseConsumerCreature", []):
        rec = [recipe_id[r] for r in o.get("targetResourcesTypesForOutput") or [] if r in recipe_id]
        if not rec:
            continue
        go = o["_goName"]
        creatures.append({"key": go, "nameKey": pick(f"{go}_NAME", f"{go.removesuffix('Creature')}_NAME"),
                          "recipes": rec, "transforms": bool(o.get("transformInsteadOfProduce"))})

    # --- crops: seed -> plant on a farm plot -> harvest ---
    # Mechanics from the game code (CropBuilding.UpdateGrowth, RenewableResourceSource.*):
    # once: plant grows (only while watered), is destroyed on harvest, drops `loot` (min..max); replant a seed.
    # renewable: after growing, gains `chargesPerInterval` charges every `interval` s (capped at `maxCharges`,
    #            stops when full; does NOT need water). Harvest of all charges yields `itemsPerHarvest` (min..max)
    #            when `burst`, otherwise 1 item per charge. Collector bots with Enhanced Laser: +100%.
    crops = []
    for o in by_class.get("SeedResourceScriptableObject", []):
        plant = objs.get(o["cropType"], {})
        c = {"seed": o["resourceId"], "plant": plant.get("_goName"),
             "plantNameKey": f"{plant.get('_goName')}_BUILDING_NAME",
             "growthTime": clean(o["totalGrowthTime"]),
             "water": {"balls": o["maxWaterBalls"], "ballDuration": o["waterBallDuration"]}}
        if plant.get("_class") == "RenewableResourceSource":
            burst = bool(plant["spawnAllResourcesAtOnce"])
            c["harvest"] = {"type": "renewable", "item": item_id.get(plant["extractedResources"]),
                            "interval": clean(plant["intervalToSpawnResources"]),
                            "chargesPerInterval": plant["numberOfResourcesSpawnedPerInterval"],
                            "maxCharges": plant["maxResources"], "burst": burst}
            if burst:
                c["harvest"]["itemsPerHarvest"] = [plant["resourcesToSpawn"]["x"], plant["resourcesToSpawn"]["y"]]
        else:
            loot = (plant.get("loot") or [{}])[0]
            c["harvest"] = {"type": "once", "item": item_id.get(loot.get("resource")),
                            "perHarvest": [loot.get("minAmount"), loot.get("maxAmount")]}
        crops.append(c)

    data = {
        "source": "Nova Lands game files",
        "constants": {"waterBall": next((i["id"] for i in items.values() if i["key"] == "WaterBallResource"), None),
                      # WorldGenerator (scene level9): flat-top hexagon islands of radius (12, 10), neighbours at
                      # (0, ±2·8.66) and (±18, ±8.66); GridManager: 0.5 world-unit cells. Saves store world positions.
                      "island": {"radius": [12, 10], "cell": 0.5},
                      # TransporterContainer: carries transportedResourcesPerRound items per transportDuration; the
                      # timeToTryToTransport wait does not add up while items are waiting (measured: 20 items in 20 s)
                      "transporter": next(({"tryInterval": clean(o["timeToTryToTransport"]), "duration": clean(o["transportDuration"]),
                                            "perRound": o["transportedResourcesPerRound"]}
                                           for o in by_class.get("TransporterContainer", []) if o.get("buildingId") == 58), None)},
        "items": sorted(items.values(), key=lambda x: x["id"]),
        "recipes": sorted(recipes.values(), key=lambda x: x["id"]),
        "buildings": sorted(buildings, key=lambda x: x["id"]),
        "creatures": creatures,
        "crops": crops,
        # Driller recipes offered per island (DrillerBuilding.get_AvailableRecipes -> WorldBiome.drillerExtractableResources);
        # keys are the biome names saves use (area Biome), island name = <biome>_NAME
        "drillBiomes": {o["m_Name"]: [item_id[r] for r in o["drillerExtractableResources"] if r in item_id]
                        for o in by_class.get("WorldBiome", []) if o.get("drillerExtractableResources")},
        # island colours per biome (WorldBiome.groundColor / groundBorderColor), for biomes the game names
        "biomeColors": {o["m_Name"]: {"ground": hexcolor(o["groundColor"]),
                                      "border": hexcolor(o["groundBorderColor"]) if o.get("useGroundBorderColor") else None}
                        for o in by_class.get("WorldBiome", []) if f"{o['m_Name']}_NAME" in en},
        "modifiers": {
            # Verified against save files (tools/save_reader.py --diff) and the game code (Il2CppDumper + disasm):
            #   BaseProductionBuilding.get_ProductionSpeed = ps + ps*skillBonus + ps*overclockBonus
            #   LubricantEnabledProductionBuilding: + ps*lubricantMultiplier (x4 -> +4) while lubricant lasts
            #   AnimalBarnBuilding: ps*(1 + bonusPerCreature*(n-1)) * (1 + skillBonus), no gem overclock
            #   cycle = recipe.productionTime / speed
            #   crops: growth and regrowth advance by fertilizerMultiplier*dt (x3 -> 3x, 1 without fertilizer);
            #   growth needs water, regrowth does not; water/fertilizer drain in real time while growing or
            #   regrowing (not when full), fertilizer only while water is present.
            "formula": {
                "production": "time = recipe.time / (building.productionSpeed * (1 + skills + gem + lubricant))",
                "animalBarn": "time = recipe.time / (building.productionSpeed * (1 + bonusPerCreature * (n - 1)) * (1 + skills))",
                "cropGrowth": "time = crop.growthTime / fertilizer.multiplier (only while watered)",
                "cropRegrowth": "interval = harvest.interval / fertilizer.multiplier (water not required)",
                "waterBalls": "balls per growth = growthTime / fertilizer.multiplier / water.ballDuration",
            },
            "lubricants": simple("LubricantScriptableObject", multiplier="lubricantGrowthSpeedMultiplier",
                                 duration="lubricantDuration"),
            "fertilizers": simple("FertilizerScriptableObject", multiplier="fertilizerGrowthSpeedMultiplier",
                                  duration="fertilizerDuration"),
            "overclockGems": simple("OverclockGemScriptableObject", speedBonus="speedMultiplierBonus"),
            "overclockGroups": gem_groups,
            "drills": simple("DrillResourceScriptableObject", speedMultiplier="speedMultiplier", duration="duration"),
            "skills": sorted(skills, key=lambda x: x["id"]),
        },
    }
    os.makedirs(os.path.join(out_dir, "locale"), exist_ok=True)
    with open(os.path.join(out_dir, "gamedata.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    used = set(EXTRA_KEYS) | {k for k in en if k.endswith("Biome_NAME")}  # island names for save import
    def collect(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("nameKey", "descKey", "plantNameKey") and v:
                    used.add(v)
                else:
                    collect(v)
        elif isinstance(x, list):
            for v in x:
                collect(v)
    collect(data)
    for lang in langs:
        table = en if lang == "en" else load_loc(root, lang)
        loc = {k: table[k] for k in sorted(used) if k in table}
        with open(os.path.join(out_dir, "locale", f"{lang}.json"), "w", encoding="utf-8") as f:
            json.dump(loc, f, ensure_ascii=False, indent=1)
        print(f"locale {lang}: {len(loc)}/{len(used)} keys")
    prod = [b for b in data["buildings"] if b.get("recipes")]
    print(f"items {len(data['items'])}, recipes {len(data['recipes'])}, buildings {len(data['buildings'])} "
          f"({len(prod)} with recipes), skills {len(skills)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:] or ["en"])
