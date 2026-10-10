# NovaCalc — production chain calculator for Nova Lands

Web app: a board (canvas) of building cards connected input → output, with automatic rate math, bonuses,
save-file import and goal planning. Game: `C:\Program Files (x86)\Steam\steamapps\common\Nova Lands`
(Unity 2022.2.8f1, IL2CPP). The user writes in Russian; answer in Russian. Plan and status: `TODO.md`.

## Run

```
python -m http.server 8642        # from the repo root
```
Open http://localhost:8642/app/ (root `index.html` redirects). In the desktop app: preview config `novacalc`
in `.claude/launch.json`. No build step, plain ES modules, no dependencies.

## Hosting

Public repo https://github.com/frostmx/novacalc, GitHub Pages from `main` (repo root) →
https://frostmx.github.io/novacalc/ (root `index.html` redirects to `app/`). Every push to `main` redeploys
(~1 min). Not in git (`.gitignore`): `data/raw/`, `.tmp/`, mod `bin/obj`, local `.claude` settings. Commits use the
repo-local GitHub noreply identity. Browsers may cache old modules after a deploy — hard reload.

## Layout

```
app/            the calculator (served as-is)
  index.html    toolbar (mode switch, + Island), catalog sidebar, #viewport (#world > #frames, svg#edges, #nodes;
                #arch > svg#arch-hexes, #arch-blds, #arch-labels), summary, dialogs
  main.js       UI: state, rendering, pointer interaction, catalog, bonuses dialog, save/factory import,
                goals + "Build chain", island layout, islands + placed buildings (model ops for the architect)
  arch.js       architect mode: hexagon islands, buildings at real size, placing/moving (DOM, via ctx.ops)
  world.js      island geometry, footprints, grid snapping, placement checks (no DOM)
  calc.js       pure math: speed, ports, flow allocation, totals (no DOM)
  data.js       loads data/gamedata.json, builds lookups: entries, producers/consumers, names, presets
  save.js       save decoding (base64 → bzip2 → tree), own bzip2 decoder; readProfile / readFactory / readLayout
  i18n.js       t()/tk()/plain(), static texts via data-i18n attributes
  locale/en.json   UI strings (UI_* keys)
data/
  gamedata.json normalized game data (generated)
  locale/en.json   game strings for the keys gamedata uses (generated)
  raw/cls_*.json   raw MonoBehaviour dumps (generated, used by build_data.py)
tools/
  extract_game.py  game assets → data/raw (UnityPy + TypeTreeGeneratorAPI)
  build_data.py    data/raw + game localization → data/gamedata.json + data/locale/<lang>.json
  save_reader.py   decode a save to JSON; --diff old new = progress of buildings/farms between two saves
  il2cpp_class.py  list a class's methods (+RVA) from Il2CppDumper dump.cs
  item_tiers.py    item progression levels (research graph) → mods/BaseStock/ItemTiers.cs
  il2cpp_dis.py    annotated x64 disassembly of IL2CPP methods (field/method names, float constants)
  extract_icons.py item + building sprites → data/icons.png atlas (64px cells, 16 per row) + data/icons.json
```

## Game mod (mods/BaseStock)

MelonLoader v0.7.3 is installed in the game folder (`version.dll` + `MelonLoader/`; the first launch generates
`MelonLoader/Il2CppAssemblies`, which the csproj references). `mods/BaseStock` = HUD list on the right: items in all
containers + factory inputs/outputs (every InventoryWindow under a building popup) of the current island
(F9 cycles island → all → off, hold Alt = the other scope / all when off, F10 settings menu), per-minute rates from the placed buildings (Rates.cs); sorted by tier (game progression, thin line between
tiers; `SortMode = alpha` for names), column fills to the bottom then a new one (first column at the right).
Tiers: `python tools/item_tiers.py` → `mods/BaseStock/ItemTiers.cs` (item level from the research graph: research =
1 + max(required researches, items it costs); item = earliest recipe max(recipe/building unlock, inputs); raw items
half a level before their first use; mega furnaces skipped — credit-bought shortcut). The mod computes the same
in game at world load (`TierCalc.cs`, from ResearchesList/RecipesList/BuildingsList prefabs) and logs differences to
ItemTiers.cs (fallback); verified identical except the unused OrganicMaterial (not in ResourcesList).
Tier bounds: pref `TierBounds` (levels 6,10,13,16,18).
Build + install: `dotnet build -c Release -p:Deploy=true` (copies to `<game>\Mods`; the game locks the DLL while running).
Log: `<game>\MelonLoader\Latest.log`; settings: `<game>\UserData\MelonPreferences.cfg` (`[BaseStock]`).
Interop: global-namespace game types are in `Il2Cpp`, TMP in `Il2CppTMPro`; private fields are exposed as properties.
Container content = `BaseContainer.popup` → `BaseContainerPopup.inventory.GetInventoryContent()`;
`WorldArea.allItemsCount` counts only logistics-source containers + ground items, so it is not used.

## App model (main.js / calc.js)

- Entries = what a building can run: recipe, creature recipe (barn), crop (`crop:<seed>`, farms) or fuel burn
  (`gen:<buildingId>`, generators). Crop/generator "recipes" are synthetic, built in data.js.
- Node kinds: production `{b, r, count, c?, creatures?, lub?}`, farm `{…, fert?, water?}`, goal
  `{kind:'goal', items, every, per, preset?}`; any node may carry `g` = island (frames, energy per island).
- `compute()` builds ports per node (recipe I/O + lubricant/water/fertilizer/fuel), allocates flow over edges,
  totals per item, energy used/made overall and per island. `pruneEdges()` keeps only edges compute accepts.
- Save import (`factoryNodes` → `linkAll` → `layoutIslands`): merge equal setups per island, link producers to
  consumers (same island first), layered layout per island.
- Goals "Build chain": fill deficits upstream one at a time; reuse nodes already in the chain; prefer the fastest
  recipe that takes no packages; skip drills, workbench, cloning, creatures, farms (their products stay raw).
- Two modes (`state.mode`): calculator board (`state.view`) and architect (`state.archView`, 1 world unit = 32px,
  y flipped). Islands = `state.groups[g]` `{title, biome, q, r, locked?, frame?}` (hex slot for the architect,
  `frame` = remembered board spot of an island without cards). `state.placed[]` `{id, b, g, x, y, node?}` =
  buildings on islands, x/y relative to the island centre; with `node` they are instances of that card.
  One model: `syncPlaced()` (in `commit`) keeps ≤ `node.count` instances per card and only on the card's island;
  placing from the catalog uses a card's unplaced instance or adds +1; deleting −1; moving to another island
  transfers one to the matching card there (`transferOne`). Cards show "N not placed" once their island has a layout.
- Architect UI: production buildings show their recipe's output icon; selecting one draws lines to the instances of
  the cards linked to it (suppliers green, consumers orange) and floats its calculator card next to it (`#arch-card`,
  same handlers as the board: `onCardClick/Change/Key`). Island title inside the top edge, energy inside the bottom.
  In that card a click on a port opens the producer/consumer menu; the new card (`addLinked`) and the stepper's
  "+" arm placement of the card's unplaced buildings (`armCard`; a card stays armed until all are placed).
  Cards created by the architect (`cardOn`) are linked by `linkNode` (inputs: island producers, else any island;
  outputs: island consumers). The catalog keeps open groups/scroll across re-renders (`catalogOpen`).
- Links between islands obey transporters (`calc.js` `transportNetwork`): when both cards' islands are on the hex
  map, the flow of an edge A→B for item X is capped by the max flow of X-carrying transporters from A to B (routes
  may hop islands; edges of the same item and island pair share it, different pairs don't). No route → 0 flow,
  red dashed edge with a tooltip. Import (`linkAll`) and new architect cards (`linkNode`) take producers from other
  islands only where a route exists (else any, showing the missing route).
- Transporters: two placed arms (`TransporterContainerInput` → `…Output`) with `slot` + `twin`; placed/moved only on
  shore slots (`world.js` `TRANSPORTER_SLOTS`, `slotPair`); the twin sits on the paired slot of the facing island,
  so sliding an arm to another edge moves the twin to that neighbour. Deleting one removes both.
  The carried item lives on the input arm (`item`, save: `RequiredResource`; the output arm has −1); both arms show
  it, selecting an arm opens a small panel to change it, a new transporter is selected right away.
- Calculator view (`state.boardView`): 'islands' (frames, `layoutIslands`) or 'chain' (one layered chain,
  `layoutBoard`, cards show their island); positions are kept per view in `state.layouts[view]` and swapped by
  `setBoardView` (first visit / "Arrange" = `arrangeBoard`). Island membership changes only in the island view.
- Board islands: "+ Island" makes an empty frame; dropping a card into a frame (smallest one wins) moves it to that
  island, dragging it well away from its own frame takes it off; × deletes an island (cards stay), double click renames.

## Rules

- **All visible text goes through localization keys.** Game text: the game's own keys (`nameKey`/`descKey` in
  gamedata, resolved from `data/locale/<lang>.json`). UI text: `UI_*` keys in `app/locale/<lang>.json`. English
  first; other languages are added in bulk later (`build_data.py … data en ru_RU de …` + a UI file). Never
  hardcode English in JS/HTML. Game strings may contain rich text — use `plain()`.
- New game keys the UI needs must be exported: `build_data.py` exports only keys referenced by gamedata plus
  `EXTRA_KEYS` and all `*Biome_NAME` (island names).
- Data claims must come from the game: files, save experiments or the game code — not guesses. The wiki is
  only a cross-check and is outdated in places (it misses `productionSpeed`).

## Data pipeline

```
pip install -r tools/requirements.txt          # UnityPy==1.25.4, TypeTreeGeneratorAPI, capstone, pefile
python tools/extract_game.py "<game dir>" data/raw
python tools/build_data.py   "<game dir>" data/raw data [en ru_RU …]
python tools/extract_icons.py "<game dir>" data/raw data     # needs gamedata.json first
```
- Typetrees are stripped; layouts are regenerated from `GameAssembly.dll` + `global-metadata.dat`.
  TypeTreeGeneratorAPI quirks: use `get_nodes_as_json` (raw `get_nodes` fails), pass the assembly name
  **without** `.dll`, and set the align flag (0x4000) on `m_Enabled` yourself or `m_Script` reads shifted.
- A few consumable subclasses fail to read; they fall back to base fields up to `sprite` (name, id, icon),
  marked `partial`. When truncating a schema keep the cut field's child nodes, or PPtrs come out empty.
- Icons: items use `sprite`; buildings the `uiIcon` SpriteRenderer (fallback `sprite`). Game art is ~16px pixel
  art — upscaled by a whole factor with NEAREST; the UI shows it with `image-rendering: pixelated`.
- Game localization files are JSON with trailing commas (`messages_<lang>.bytes`).
- References in raw dumps are `"<file>:<pathId>"`.

### gamedata.json
- `items` (id, key, nameKey, packageOf for packages: name = name(inner) + `PackageResourceSuffix`)
- `recipes` (id, inputs/outputs `{item, amount}`, `time` = base seconds)
- `buildings` (id, key = GameObject name, `recipes`, `productionSpeed`, `lubricant`, `energy` = required,
  `producedEnergy`/`fuel` for generators, `maxCreatures`/`bonusPerCreature` for the barn, `farm.plots`)
- `creatures` (barn recipes per species), `crops` (seed → plant → harvest), `constants.waterBall`,
  `constants.island` (radius, grid cell)
- building `footprint {w, h, x, y}` (placementCollider box, centre relative to the position) and `placementOffset`;
  `biomeColors` (biome → ground / border colour)
- `drillBiomes` (biome name → item ids a Driller can mine there)
- `modifiers`: lubricants, fertilizers, overclockGems, overclockGroups (slot i = group i), skills
  (speed / efficiency / extraOutput / containerSize per building), drills (`duration`, `speedMultiplier`), `formula`.

## Verified game mechanics (save experiments + disassembly)

- Production: `speed = productionSpeed × (1 + skills + gem + lubricantMultiplier)`, cycle = `recipe.time / speed`.
  `productionSpeed` is 0.8 for furnaces/refineries/assemblers. Lubricant ×4 counts as +4.
  (`BaseProductionBuilding.get_ProductionSpeed`, `LubricantEnabledProductionBuilding.get_ProductionSpeed`)
- Mega furnaces (`ContinuousProductionBuilding`): same total rate, output spawned one by one.
- Animal Barn: `ps × (1 + 0.5·(n−1)) × (1 + skills)`, no gem, no lubricant.
- Output bonus (Agriculture): output + `round(amount × bonus)` per cycle; chance is ignored; RoundToInt = half-even.
- Lubricant: 1 item per `duration` s per building while producing (real time).
- Gem Overclocker: inventory slot i → `buildingsGroups[i]`.
- Farms: growth/regrowth advance by `fertilizerMultiplier × dt` (×3, not +3). Growth needs water; regrowth of
  renewable plants does not. Water burns in real time while growing/regrowing (not when full); fertilizer burns
  only while there is water — so an unwatered renewable plant keeps the fertilizer boost forever.
  Renewable: every `interval` +`chargesPerInterval` (cap `maxCharges`); harvest: burst → Random(min..max) items,
  else 1 per charge. Collector bot + Enhanced Laser (research 1149): +100%. Irrigation Efficiency
  (research 454): Advanced Farm counts each water ball twice.
- Skill state in saves: 2 = learned.
- Generators (`EnergyGenerationBuilding`): fuel burns continuously, one item per
  `fuelDuration × (1 + efficiency skills)` (ExtraSmoke/ExtraFuel/ExtraNuclear +25%); output `producedEnergy`
  units, solar panels × Solar Power (research 456) rounded. Energy is pooled **per island** (`WorldArea.AllocateEnergy`),
  buildings hold `requiredEnergy` units while placed.
- Driller (`DrillerBuilding`): normal speed formula (no skills/gems/lubricant apply), recipes 0.11 s; the cycle timer
  resets to 0 (not `-= cycle`), so at most one item per frame (60 FPS → 7 frames ≈ 514/min; the app shows nominal 545
  and the 60 FPS figure in a tooltip). Drill bit: one per `duration` (225 s) of drilling, real time
  (`ConsumeDrill`). Minable items per island: `WorldBiome.drillerExtractableResources` → `gamedata.drillBiomes`
  (biome name → item ids); import keeps the biome in `state.groups[g].biome`.
- World layout (`WorldGenerator`, scene level9): islands are flat-top hexagons of radius (12, 10) on an axial grid,
  centre = (18q, 5√3·q + 10√3·r); rings 0/1/2 hold 1/6/12 islands (ring 3 = out-of-map). Saves store island centres
  (`Area.X/Y`) and world positions of every building (`Buildings[].X/Y`, no rotation). Placement: GridManager cells
  are 0.5; `position − placementOffset` sits on a cell centre in world coordinates (all player-built buildings of a
  save match); footprint = `placementCollider` BoxCollider2D (size N·0.5 − 0.05). Premade NPCs/landmarks don't snap
  and have no collider.
- Transporter = two arms on paired shore slots: every island has the same 48 `TransportersSlots` (8 per edge, save);
  slot e·8+k pairs with slot ((e+3) mod 6)·8+(7−k) of the island across edge e; arms store `TwinContainer {Id, Area}`,
  the input arm's `RequiredResource` = the item it carries.
- Transporter rate: `transportedResourcesPerRound` (1) item per `transportDuration` (1 s) = 60/min per transporter
  while it has items (measured in game: 20 items in 20 s). Reading `UpdateIdle` suggested an extra 1 s
  `timeToTryToTransport` wait per item — the measurement shows it does not add up, so trust the measurement.
  `automationTransporterContainerSpeedBonus` exists on PlayerSkillDescriptor but is 0 on every skill.
- Oxygenator (`BasePlayer.UpdateOxygen`, `OxygenatorBuilding.get_OxygenPerWaterUnit`): once a second on an island with
  `ConsumeOxygenHere` the player loses `oxygenDrainPerSecond`; the `oxygenConsumptionBonus` skill applies only where
  `!area.HasOxygenator()`. Below `oxygenPercentToConsumeFromOxygenator` of max the player refills from the oxygenator,
  which makes `oxygenPerWaterUnit + RoundToInt(oxygenPerWaterUnit × efficiency)` oxygen per water ball (Oxygenator
  efficiency skills 127/187/315, +15% each) → water balls/min = 60 × drain / that.
- Workbench (`MegaPrinter`) is manual crafting; Animal Cloning Machine is a one-off tool — both skipped on import.
- Mega recipes consume packages (1 package = 100 items): fast but ruinous — auto-build avoids them.

## Saves

`%USERPROFILE%\AppData\LocalLow\BEHEMUTT\Nova Lands\Worlds\1.1.0\WORLDnnn.dat` — base64 → bzip2 → tree:
tag byte, then 1 list | 2 dict | 3 string (7-bit length) | 4 int32 | 5 int64 | 6 bool | 7 float32 | 8 float64.
Written after sleeping and on "save and exit". Buildings: `World.World.LayerN[area].Buildings[]`
(`BuildingId`, `RecipeId`, `CurrentProductionTime` = elapsed seconds of the cycle — it stops exactly at the
cycle length when output is full, handy for measuring; `CurrentRequiredLubricant`, `CreatureCount`,
farm plots: `Seed`/`CurrentRequiredCrop`, `Water`, `Fertilizer`, `Crop.CurrentTotalGrowthTime`).
Areas have `Biome` → island name key `<Biome>_NAME`. `PlayerSkills[{Id, State}]`.
To measure mechanics: copy a save, let the user play ~1–3 min without sleeping/menus, save again,
`python tools/save_reader.py --diff a.dat b.dat`.

## Reading the game code

Il2CppDumper v6.7.46 (github.com/Perfare/Il2CppDumper, `-net6` build, run with `dotnet`) on
`GameAssembly.dll` + `global-metadata.dat` → `dump.cs`, `script.json` (keep them in the session scratchpad,
not in the repo). Then `tools/il2cpp_class.py dump.cs Class "regex"` and
`tools/il2cpp_dis.py GameAssembly.dll <out> Class <method|0xRVA>` (env `RETS=n` = stop after n `ret`s).
Vtable offset → slot: `slot = (offset − 0x138) / 16`, look up `Slot: N` in dump.cs. Field annotations are
for the given class; other objects' fields may be mislabeled.

## Testing in the browser

- Preview tab via `preview_start` name `novacalc`; set a desktop-size viewport (e.g. 1500×900) and reset
  it afterwards. Screenshots can lag a frame — take another after a short wait.
- File inputs can't be filled from disk: copy the save into `./.tmp/`, `fetch('/.tmp/…')`, build a `File`,
  put it into the input via `DataTransfer`, dispatch `change`. Override `window.confirm` when needed.
  Delete `.tmp/` and clear `localStorage['novacalc.board.v1']` when done.
- Collapsed `<details>` have empty `innerText`; use `textContent`.
- Synthetic events: dispatch keys on `document.body` (handlers call `ev.target.closest`); in the architect,
  client coords of a world point = viewport rect + `archView.x/y` + (x, −y)·32·z. Offsets in screen px are huge
  board distances at low zoom.
- Screenshots sometimes freeze on an old frame while a large viewport is emulated; reset to the desktop preset
  and hover/click with real coordinates (synthetic `mouseover` doesn't trigger `mouseleave` later).
- Syntax check: `node --input-type=module --check < app/file.js`. `save.js` runs under Node for tests.

## Gotchas met so far

- An element with an explicit `display` ignores the `hidden` attribute — `[hidden]{display:none!important}` exists.
- Bash heredocs: `'EOF'` keeps backslashes literal (a `\n` meant for JS ended up as a real newline once) and
  `\N…` breaks Python string literals; for anything non-trivial write a script file with the Write tool.
- A command waiting on stdin (`cat > file` without input) hangs until the timeout.
- The browser may cache `data/locale/*.json` after a rebuild — reload before concluding a key is missing.
