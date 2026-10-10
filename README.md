# NovaCalc

Production chain calculator and island planner for [Nova Lands](https://store.steampowered.com/app/1501610/Nova_Lands/).

**▶ Open it: https://frostmx.github.io/novacalc/**

Everything runs in your browser. A save file you import is read locally and never uploaded.

## What it does

**Calculator**
- Place building cards on a board and connect outputs to inputs. Rates per second, minute or hour are calculated
  for you, and shortages and surpluses are highlighted on every port.
- Uses the game's real numbers: building speed, skills, Gem Overclocker gems, lubricants, fertilizers, farm
  watering, Animal Barn creatures, generator fuel and energy per island, drills and their drill bits.
- Goals: pick a delivery target (Black Hole Pyramid, Nova Gateway, …) or your own list. "Build chain" adds the
  buildings needed down to raw resources.
- Summary of everything made and used. Hover an item to highlight its producers and consumers; click it to zoom
  to them.
- Two views: cards grouped by island, or the whole chain at once, each with automatic layout.

**Import from save**
- Load your world file and get your whole factory on the board: buildings merged into cards per island and setup,
  linked into chains, with your learned skills and gems applied.
- Save location: `%USERPROFILE%\AppData\LocalLow\BEHEMUTT\Nova Lands\Worlds\1.1.0\WORLD000.dat`

**Architect**
- Islands as hexagons on the world map, in their biome colours. Buildings stand where they are in the game, at
  their real size, snapped to the game's grid.
- Place, move and delete buildings. Each one is an instance of its calculator card, so counts stay in sync both ways.
- Select a building to see links to its suppliers and consumers and edit its card right there. Click a port to
  add a producer and place it on the map.
- Transporters: arms placed on shore slots, paired with the facing island and showing the item they carry.
  Links between islands are limited by what the transporters carry (60 items/min each).

**Save editor**
- After importing a save, the architect edits that world: place, move and delete buildings (an Advanced Farm moves
  with its plots and plants), change recipes, lay transporters, move rocks and bushes out of the way.
- Rocks, bushes and trees are shown on the islands; buildings can't be put on top of them. NPCs, shops and landmarks
  stay where they are. New buildings are free, but only types your save already has can be placed.
- "Download save" writes the changes into a copy of your save file. Putting it into
  `%USERPROFILE%\AppData\LocalLow\BEHEMUTT\Nova Lands\Worlds\1.1.0\` is up to you: close the world first and keep a
  backup of the old file.

## Where the numbers come from

All data is extracted from the game files (Unity IL2CPP): recipes, buildings, modifiers, footprints, biome colours,
icons. Formulas were checked against the decompiled game code and timed in-game save experiments, not taken from
the wiki.

## Run locally

No build step and no dependencies:

```
python -m http.server 8642
```

Then open http://localhost:8642/app/.

## Regenerate the game data

```
pip install -r tools/requirements.txt
python tools/extract_game.py "<Nova Lands install dir>" data/raw
python tools/build_data.py   "<Nova Lands install dir>" data/raw data en
python tools/extract_icons.py "<Nova Lands install dir>" data/raw data
```

`tools/save_reader.py` decodes a save to JSON; `--diff old.dat new.dat` shows production progress between two
saves, which is handy for measuring mechanics. Developer notes are in [CLAUDE.md](CLAUDE.md), plans and status in
[TODO.md](TODO.md).

`mods/BaseStock` is a small MelonLoader mod: an in-game HUD listing the items stored on the current island.

## Disclaimer

Fan-made and not affiliated with BEHEMUTT. Nova Lands, its names, texts and sprites belong to their owners.
