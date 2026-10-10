# BaseStock — developer notes

BaseStock is a MelonLoader mod for Nova Lands (Unity 2022.2.8, IL2CPP). It adds a list on the right side of the
HUD. The list shows every item held by the buildings of the current island: containers, plus the inputs and
outputs of factories. It is sorted by game progression and shows the synthetic income or consumption of each item.
The player-facing description is in [`nexus/description.bbcode`](nexus/description.bbcode).

## Setup from scratch

1. **.NET SDK** 6 or newer (the project targets `net6.0`; SDK 9/10 work).
2. **MelonLoader 0.7.x** in the game folder ([releases](https://github.com/LavaGang/MelonLoader/releases)). Unzip
   `MelonLoader.x64.zip` next to `Nova Lands.exe`, which gives `version.dll` and `MelonLoader/`.
3. **Start the game once** and wait for the main menu. On the first launch MelonLoader generates the interop
   assemblies in `MelonLoader/Il2CppAssemblies`, which takes 1–3 minutes. "Failed to restore N methods" in the log
   is normal unstrip statistics. The run is fine when the log ends with `Assembly Generation Successful!`.
4. **Build and install** (the game must be closed, because it locks the DLL while running):
   ```
   dotnet build mods/BaseStock -c Release -p:Deploy=true
   ```
   `Deploy=true` copies `bin/Release/net6.0/BaseStock.dll` to `<game>\Mods`. The game folder defaults to the Steam
   path. Override it with `-p:GameDir="D:\Games\Nova Lands"`.

The csproj references `MelonLoader/net6/MelonLoader.dll`, `Il2CppInterop.Runtime.dll` and every DLL in
`MelonLoader/Il2CppAssemblies`. If the game updates, start it once so MelonLoader regenerates them, then rebuild.

## Files

| File | What it does |
|---|---|
| `BaseStock.cs` | Main class: preferences, F9 and Alt, popup hiding, counting, building the entry list, sorting, the layout of rows, columns and tier lines, UI creation under the HUD canvas |
| `Rates.cs` | Synthetic income and consumption per item per minute, from the placed buildings |
| `TierCalc.cs` | Item progression levels computed in game from the research graph at world load |
| `ItemTiers.cs` | The same levels generated offline by `tools/item_tiers.py`. Fallback and reference: differences are logged |
| `Menu.cs` | F10 settings menu, EN/RU labels |
| `nexus/` | Nexus page: summary, BBCode description, header and screenshots. `*.zip` release archives are git-ignored |

### Counting (`BaseStock.cs` → `CountArea`)

Every building keeps its items in `InventoryWindow`s inside its popup (`BaseBuilding.popup`). The mod sums
`GetInventoryContent()` of every window found under the popup. That covers a container's inventory, a factory's
input and output, lubricant and drill slots, farm seeds and fertilizer, and generator fuel. The window list per
building is cached for 30 refreshes, because `GetComponentsInChildren` allocates.

`WorldArea.allItemsCount` is **not** used. It only counts containers marked as a logistics source
(`BaseContainerPopup.OnChangeItemsCount` updates it only when `container.IsResourceSource`), plus items on the ground.

Scope: `WorldUpdateManager.CurrentPlayerArea` gives the current island, `WorldManager.GetWorldAreasList()` gives all
islands.

### Rates (`Rates.cs`)

Rates are nominal: what the buildings make at full speed, not a measurement. Every number is read from the running
game:

- **Production** (`BaseProductionBuilding`, `LubricantEnabled…`, `Continuous…`, `DrillerBuilding`,
  `AnimalBarnBuilding`): `currentRecipe`, cycle = `productionTime / speed`.
  - Speed is the game's `ProductionSpeed` getter, except for lubricant buildings. Their getter adds the lubricant
    only while one is loaded, so the mod rebuilds the speed as `ps·(1 + productionSpeedBonus + overclock +
    lubricant)` with the lubricant the player selected.
  - Outputs get `+ RoundToInt(amount × productionOutcomeBonus)` per cycle.
  - Lubricant burns 1 per `lubricantDuration` s; a drill bit wears 1 per `duration` s.
  - The Workbench (34) and the Animal Cloning Machine (439) are skipped.
- **Farm plots**, including Advanced Farm plots: seed → `cropType`.
  - Once-crops: one harvest per `totalGrowthTime / fertilizer`.
  - Renewable plants (`RenewableResourceSource`): yield per `intervalToSpawnResources / fertilizer`.
  - Water burns 1 ball per `waterBallDuration` s while the plant grows, halved on an Advanced Farm with
    `duplicateWaterBalls`. Fertilizer burns only while the plot is watered.
- **Generators**: fuel burns 1 per `fuelDuration × (1 + productionEfficiencyBonus)` s.
- **Oxygenator**: water balls per minute = `60 × player.oxygenDrainPerSecond / (oxygenPerWaterUnit +
  round(oxygenPerWaterUnit × efficiency))`. From `BasePlayer.UpdateOxygen`: the `oxygenConsumptionBonus` skill only
  applies on islands without an oxygenator.

**Real mode** (`RateSource = real`) counts only the buildings that are working right now. A building counts when
its progress counter moved within the last 5 s of game time (`Time.time`, so a paused game freezes the state):

- `currentProductionTime` for production buildings. It stops when the building is unpowered or short of inputs. With
  a full output it waits at the cycle end, while `IsProducing` stays true, so that flag alone is not enough.
- The crop's `currentTotalGrowthTime`, plus a renewable plant's `currentTime` and `currentResources`, for farm plots.
  An empty plot is stopped.
- `currentFuelDuration` for generators.

The first time a building is seen, the game's own flag decides (`IsProducing`, a planted crop, `consumingFuel`).
The oxygenator counts only while the player is on an island with `ConsumeOxygenHere`. The header then shows
working/counted buildings, e.g. `/min · 34/41`.

The mechanics behind these formulas are listed with their sources (save experiments, disassembly) in the repo's
`CLAUDE.md`, under "Verified game mechanics".

### Tiers (`TierCalc.cs`, `tools/item_tiers.py`)

Item level is computed from the research graph:

- **Research level** = 1 + max(levels of the researches it requires, levels of the items it costs).
- **Recipe or building level** = 0 if it has `startUnlocked`, or if it is a recipe that no research unlocks.
  Otherwise it is the lowest level of a research that unlocks it.
- **Item level** = the lowest, over the recipes that produce it, of max(recipe level, building level, levels of the
  recipe's inputs).
  - Mega furnaces are skipped: their blueprints are bought with credits only, so they never give first access.
- **Raw item level** (an item no recipe produces) = half a level before the first research or recipe that consumes
  it.

Example: Titanium Ingot is a 2-step recipe, but its research needs GlassWorks, which costs Electronic Parts. So
titanium lands after electronics.

`TierBounds` (default `6,10,13,16,18`) cuts the levels into tiers I–VI. Packages (`IsPackage`) form the last group.
Items without a level (not reachable in the research graph) go just before the packages. Inside a tier, items are
ordered by level, then by the game's `ResourcesList` order.

At world load the mod computes the levels in game (`ResearchesList.Researches`, `RecipesList.Recipes`,
`BuildingsList.Buildings` prefabs with `availableRecipes`) and logs differences to `ItemTiers.cs`. After a game
patch, regenerate the offline table: `python tools/item_tiers.py` (needs `data/raw` from `tools/extract_game.py`).

### UI

- The list is a child of `HUDManager.mainCanvas`, so it uses the HUD scale and the game's TMP font (taken from a
  HUD label).
- It follows the HUD fade via `hudCanvasGroup`. It hides when `BasePlayer.IsInteractingWithPopup()` is true or
  `PopupManager.CurrentPopup` is set.
- The F10 menu is a uGUI panel on the same canvas. Clicks are hit-tested with
  `RectTransformUtility.RectangleContainsScreenPoint`, not through the game's EventSystem. Labels are Russian when
  a game string contains Cyrillic.

## Reading the game code

Fields, offsets and formulas were taken from the game binary:

1. [Il2CppDumper](https://github.com/Perfare/Il2CppDumper) (net6 build) on `GameAssembly.dll` +
   `Nova Lands_Data/il2cpp_data/Metadata/global-metadata.dat` gives `dump.cs` and `script.json`. Keep them
   outside the repo.
2. `python tools/il2cpp_class.py dump.cs <Class> "<regex>"` lists a class's methods with their RVAs.
3. `python tools/il2cpp_dis.py GameAssembly.dll <dump dir> <Class> <method|0xRVA>` gives an annotated disassembly
   (field names, called methods, float constants). Set env `RETS=n` to stop after n `ret`s.
4. A vtable offset maps to a slot as `slot = (offset − 0x138) / 16`; look up `Slot: N` in `dump.cs`.

In the interop assemblies, global-namespace game types live in `Il2Cpp` (`using Il2Cpp;`), TextMeshPro in
`Il2CppTMPro`, and `MuttInventory` in `Il2CppMuttInventory`. Private and protected fields are exposed as public
properties with the same name. Cast with `TryCast<T>()` and `Cast<T>()`, and get the runtime class name with
`GetIl2CppType().Name`.

## Testing

- **Log**: `<game>\MelonLoader\Latest.log`. After a world loads you should see:
  ```
  [BaseStock] UI built under 'HUDManager', font 'Munistic SDF'
  [BaseStock] oxygenator: drain 10/s, oxygenPerWaterUnit 200, efficiency 0.15, per ball 230
  [BaseStock] tiers: computed in game, 193/192 items from 195 researches, ...; differs from ItemTiers.cs for 1: #4 0->none
  ```
  `#4` is OrganicMaterialResource, an unused item that is missing from `ResourcesList`, so it is expected.
  Rate errors per building are logged once as warnings (`rates: building N: ...`).
- **Rates**: compare a few rates with the recipes, e.g. in NovaCalc. For example, Desert Island showed sand −16,
  glass +1.4, bottles +4.1 with Advanced Electric Furnaces at speed 0.8·(1 + 0.25 + 0.10).
- **Settings**: `<game>\UserData\MelonPreferences.cfg`, section `[BaseStock]`. The F10 menu writes it on close.
- Workflow: build while the game runs, close the game, `-p:Deploy=true` (or copy the DLL), start the game.

## Preferences

| Key | Default | Meaning |
|---|---|---|
| `Mode` | `island` | `island` \| `all` \| `off` (F9 cycles) |
| `ScopeKey` / `PeekKey` / `MenuKey` | `F9` / `LeftAlt` / `F10` | Keys (LeftAlt also accepts RightAlt) |
| `RateSourceKey` | `LeftControl` | Tap to switch `RateSource` synthetic ↔ real. Fires on release, only if no other key or button was pressed meanwhile; also accepts RightControl |
| `RateMode` | `net` | `net` \| `both` \| `off` |
| `RateUnit` | `minute` | `minute` \| `hour` |
| `RateSource` | `synthetic` | `synthetic` = every placed building at full speed \| `real` = only working buildings |
| `SortMode` | `tier` | `tier` \| `alpha` |
| `TierBounds` | `6,10,13,16,18` | Level where each tier from II up starts |
| `ShowNames` | `false` | Item names next to icons |
| `CountBuildingInventories` | `true` | `false` = containers only |
| `HideWithPopups` | `true` | Hide while a building window or game popup is open |
| `Scale` | `1.0` | Size of font, icons and rows (0.5–3) |
| `FontSize`, `RowHeight`, `IconSize`, `SeparatorHeight` | `18`, `22`, `20`, `5` | Base sizes in HUD canvas units, multiplied by `Scale` |
| `TopMargin`, `BottomMargin`, `RightMargin`, `ColumnGap` | `75`, `110`, `8`, `6` | Free space around the list |
| `BackgroundAlpha` | `0.72` | Column background opacity |
| `RefreshSeconds` | `1` | Recount interval |

## Release

1. Bump the version in `[assembly: MelonInfo(..., "1.0.0", ...)]`.
2. `dotnet build mods/BaseStock -c Release`.
3. Pack the release archive. Its layout must be `Mods/BaseStock.dll`, so it can be unzipped straight into the game
   folder (Vortex understands it too). Name it `nexus/BaseStock-<version>.zip`; zips are git-ignored.
4. Upload it to Nexus. Keep `nexus/summary.txt` and `nexus/description.bbcode` up to date. The description loads
   its images from GitHub raw URLs (`mods/BaseStock/nexus/*.png` on `main`), so push new screenshots before
   editing the page.

## Known limitations

- Synthetic rates are nominal. Real mode drops stopped buildings, but a working building is still counted at its
  full speed. The Collector Bot harvest bonus is not counted in either mode.
- The oxygenator rate assumes the player stays on islands that consume oxygen.
- Raw resources that only exist on later islands (e.g. Behemuttium) still sit in tier I, because island order is
  not part of the research graph.
- Game tooltips such as "[E] INTERACT" are drawn above the F10 menu (a separate game canvas).
