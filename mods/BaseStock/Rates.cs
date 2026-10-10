// Synthetic income / consumption per item (items per minute) from what is placed on an island — nominal rates of the
// buildings' current setup, not a measurement. Same mechanics as NovaCalc (CLAUDE.md "Verified game mechanics"),
// but every number is read from the running game:
//  - production (BaseProductionBuilding, LubricantEnabled…, Continuous…, Driller, Animal Barn): currentRecipe,
//    cycle = recipe.productionTime / speed. speed = ProductionSpeed getter, except lubricant buildings: the getter adds
//    the lubricant only while one is loaded, so it is rebuilt as ps·(1 + productionSpeedBonus + overclock + lubricant)
//    with the lubricant the player selected. Outputs + RoundToInt(amount × productionOutcomeBonus) per cycle.
//    Lubricant: 1 per lubricantDuration s; driller: 1 drill per drill.duration s.
//  - farm plots (also the plots of an Advanced Farm): seed → crop prefab. once: growth = totalGrowthTime / fertilizer,
//    1 seed in, avg(loot min..max) out. renewable: every intervalToSpawnResources / fertilizer → avg(resourcesToSpawn)
//    when burst, else min(chargesPerInterval, maxResources). Water 1 ball per waterBallDuration s while growing
//    (once: always; renewable: only if the plot has water), halved on an Advanced Farm with Irrigation Efficiency;
//    fertilizer 1 per fertilizerDuration s, only while watered.
//  - generators: 1 fuel per FuelDuration (= fuelDuration × (1 + efficiency)) s.
// Real mode (RateSource = real): only buildings that are working right now count, i.e. their progress counter moved
// within the last ActiveWindow seconds of game time — currentProductionTime (stops when unpowered, starved of inputs, or
// with a full output: the timer then waits at the cycle end), the crop's growth / renewable timer and charges on a
// farm plot, currentFuelDuration of a generator. The oxygenator counts only while the player is on an oxygen island.
//  - oxygenator: water balls = 60 × player oxygenDrainPerSecond / OxygenPerWaterUnit per minute (see Oxygenator()).
// Skipped: Workbench (manual), Animal Cloning Machine (one-off), scanners / special buildings, collector-bot bonus.
using System;
using System.Collections.Generic;
using Il2Cpp;
using Il2CppInterop.Runtime;

namespace BaseStock
{
    public class Rates
    {
        public readonly Dictionary<int, double> In = new();   // consumed per minute
        public readonly Dictionary<int, double> Out = new();  // produced per minute
        readonly HashSet<IntPtr> seen = new();
        int waterId = int.MinValue;

        const int WORKBENCH = 34, CLONING = 439;
        static readonly HashSet<string> ProductionClasses = new()
        {
            "BaseProductionBuilding", "LubricantEnabledProductionBuilding", "ContinuousProductionBuilding",
            "DrillerBuilding", "AnimalBarnBuilding",
        };

        public bool Real;                 // count only working buildings
        public float Now;                 // game time (Time.time) of this refresh
        const float ActiveWindow = 5f;    // seconds of game time without progress = stopped
        public int Working, Stopped;      // buildings counted / skipped as stopped in real mode
        readonly Dictionary<IntPtr, (float value, float changed, float seen)> progress = new();

        public void Clear()
        {
            In.Clear(); Out.Clear(); seen.Clear(); Working = Stopped = 0;
            if (progress.Count > 4096)
            {
                var old = new List<IntPtr>();
                foreach (var kv in progress) if (Now - kv.Value.seen > 120f) old.Add(kv.Key);
                foreach (var k in old) progress.Remove(k);
            }
        }

        // true while the building's progress counter keeps moving; first sight trusts the game's own state flag
        bool Active(IntPtr key, float value, bool hint)
        {
            if (!Real) return true;
            bool on;
            if (!progress.TryGetValue(key, out var p)) { progress[key] = (value, hint ? Now : float.NegativeInfinity, Now); on = hint; }
            else if (value != p.value) { progress[key] = (value, Now, Now); on = true; }
            else { progress[key] = (p.value, p.changed, Now); on = Now - p.changed <= ActiveWindow; }
            if (on) Working++; else Stopped++;
            return on;
        }

        static void Add(Dictionary<int, double> d, int id, double v)
        {
            if (v <= 0) return;
            d.TryGetValue(id, out double n);
            d[id] = n + v;
        }

        public void AddArea(WorldArea area, Action<string> log)
        {
            var buildings = area?.PlayerBuildings;
            if (buildings == null) return;
            for (int i = 0; i < buildings.Count; i++)
            {
                var b = buildings[i];
                if (b == null || !seen.Add(b.Pointer)) continue;
                try { AddBuilding(b); }
                catch (Exception e) { log?.Invoke($"rates: building {b.buildingId}: {e.Message}"); }
            }
        }

        void AddBuilding(BaseBuilding b)
        {
            string cls = b.GetIl2CppType().Name;
            if (ProductionClasses.Contains(cls)) { Production(b.Cast<BaseProductionBuilding>(), cls); return; }
            if (cls == "FarmPlotBuilding")
            {
                var plot = b.Cast<FarmPlotBuilding>();
                if (!plot.hasAdvancedFarmPlotOwner) Plot(plot, null);
                return;
            }
            if (cls == "AdvancedFarmPlotBuilding")
            {
                var farm = b.Cast<AdvancedFarmPlotBuilding>();
                var plots = farm.farmPlots;
                if (plots == null) return;
                for (int i = 0; i < plots.Count; i++)
                {
                    var p = plots[i];
                    if (p != null && seen.Add(p.Pointer)) Plot(p, farm);
                }
                return;
            }
            if (cls == "OxygenatorBuilding") { Oxygenator(b.Cast<OxygenatorBuilding>()); return; }
            var gen = b.TryCast<EnergyGenerationBuilding>();
            if (gen != null) Generator(gen);
        }

        // Oxygenator (BasePlayer.UpdateOxygen, OxygenatorBuilding.get_OxygenPerWaterUnit): once a second, on an island
        // that consumes oxygen, the player loses oxygenDrainPerSecond (the oxygenConsumptionBonus skill only applies where
        // the island has no oxygenator) and refills from the oxygenator, which makes
        // oxygenPerWaterUnit + RoundToInt(oxygenPerWaterUnit × efficiency skills) oxygen per water ball.
        // → water balls / min = 60 × drain / OxygenPerWaterUnit, assuming the player stays on oxygen islands.
        public string OxygenInfo;
        void Oxygenator(OxygenatorBuilding o)
        {
            var players = WorldManager.Instance?.Players;
            if (players == null || players.Count == 0 || players[0] == null) return;
            int drain = players[0].oxygenDrainPerSecond;
            int opw = o.oxygenPerWaterUnit;
            int perBall = opw + (int)Math.Round(opw * (double)o.productionEfficiencyBonus, MidpointRounding.ToEven);
            OxygenInfo = $"oxygenator: drain {drain}/s, oxygenPerWaterUnit {opw}, efficiency {o.productionEfficiencyBonus}, per ball {perBall}";
            int water = WaterId(null);
            if (Real)
            {
                var here = WorldUpdateManager.Instance?.CurrentPlayerArea;
                if (here == null || !here.ConsumeOxygenHere) return;
            }
            if (drain > 0 && perBall > 0 && water != int.MinValue) Add(In, water, 60.0 * drain / perBall);
        }

        void Production(BaseProductionBuilding p, string cls)
        {
            if (p.buildingId == WORKBENCH || p.buildingId == CLONING) return;
            var r = p.currentRecipe;
            if (r == null || r.productionTime <= 0) return;
            if (!Active(p.Pointer, p.currentProductionTime, p.IsProducing)) return;

            double speed;
            LubricantScriptableObject lub = null;
            if (cls == "LubricantEnabledProductionBuilding")
            {
                var lp = p.Cast<LubricantEnabledProductionBuilding>();
                var req = lp.CurrentRequiredLubricant;
                lub = req != null ? req.TryCast<LubricantScriptableObject>() : null;
                if (lub == null && req == null) lub = lp.lubricant; // nothing selected: whatever is loaded
                double mult = lub != null ? lub.lubricantGrowthSpeedMultiplier : 0;
                speed = p.productionSpeed * (1 + p.productionSpeedBonus + p.overclockProductionSpeedBonus + mult);
            }
            else if (cls == "AnimalBarnBuilding")
            {
                if (p.Cast<AnimalBarnBuilding>().currentCreaturesCount <= 0) return;
                speed = p.ProductionSpeed;
            }
            else speed = p.ProductionSpeed;
            if (speed <= 0) return;

            if (cls == "DrillerBuilding")
            {
                var d = p.Cast<DrillerBuilding>();
                var req = d.CurrentRequiredDrill;
                var drill = req != null ? req.TryCast<DrillResourceScriptableObject>() : d.drill;
                if (drill == null) return; // no drill bit selected: the driller does not run
                if (drill.duration > 0) Add(In, drill.ResourceId, 60.0 / drill.duration);
            }

            double runs = 60.0 * speed / r.productionTime; // cycles per minute
            float bonus = p.productionOutcomeBonus;
            var inputs = r.input;
            if (inputs != null)
                for (int i = 0; i < inputs.Count; i++)
                {
                    var s = inputs[i];
                    if (s?.resource != null) Add(In, s.resource.ResourceId, s.amount * runs);
                }
            var outputs = r.output;
            if (outputs != null)
                for (int i = 0; i < outputs.Count; i++)
                {
                    var s = outputs[i];
                    if (s?.resource == null) continue;
                    int amount = s.amount + (int)Math.Round(s.amount * (double)bonus, MidpointRounding.ToEven);
                    Add(Out, s.resource.ResourceId, amount * runs);
                }
            if (lub != null && lub.lubricantDuration > 0) Add(In, lub.ResourceId, 60.0 / lub.lubricantDuration);
        }

        void Plot(FarmPlotBuilding plot, AdvancedFarmPlotBuilding farm)
        {
            var seedRes = plot.CurrentRequiredCrop ?? (BaseResourceScriptableObject)plot.currentSeed;
            if (seedRes == null && farm != null) seedRes = farm.currentSeedReferenceResource;
            var seed = seedRes != null ? seedRes.TryCast<SeedResourceScriptableObject>() : null;
            var crop = seed != null ? seed.cropType : null;
            if (crop == null) return;
            if (Real)
            {
                // the planted crop's growth timer (once-crops and the first growth of renewable plants) plus a
                // renewable plant's interval timer and charges; an empty plot (no seed yet) is stopped
                var cur = plot.currentCrop;
                float v = 0;
                if (cur != null)
                {
                    var cb = cur.TryCast<CropBuilding>();
                    if (cb != null) v += cb.currentTotalGrowthTime;
                    var rr = cur.TryCast<RenewableResourceSource>() ?? plot.currentCropRenewableRef;
                    if (rr != null) v += rr.currentTime + rr.currentResources * 10000f;
                }
                if (!Active(plot.Pointer, v, cur != null)) return;
            }

            var fertRes = plot.CurrentRequiredFertilizer;
            if (fertRes == null && farm != null) fertRes = farm.currentRequiredFertilizer;
            var fert = fertRes != null ? fertRes.TryCast<FertilizerScriptableObject>() : plot.fertilizer;
            double mult = fert != null && fert.fertilizerGrowthSpeedMultiplier > 0 ? fert.fertilizerGrowthSpeedMultiplier : 1;

            var renew = crop.TryCast<RenewableResourceSource>();
            bool watered;
            if (renew == null)
            {
                if (seed.totalGrowthTime <= 0) return;
                double perMin = 60.0 * mult / seed.totalGrowthTime;
                Add(In, seed.ResourceId, perMin);
                var loot = crop.loot;
                if (loot != null && loot.Count > 0 && loot[0]?.resource != null)
                    Add(Out, loot[0].resource.ResourceId, perMin * (loot[0].minAmount + loot[0].maxAmount) / 2.0);
                watered = seed.maxWaterBalls > 0;
            }
            else
            {
                if (renew.intervalToSpawnResources <= 0 || renew.extractedResources == null) return;
                double amount = renew.spawnAllResourcesAtOnce
                    ? (renew.resourcesToSpawn.x + renew.resourcesToSpawn.y) / 2.0
                    : Math.Min(renew.numberOfResourcesSpawnedPerInterval, renew.maxResources);
                Add(Out, renew.extractedResources.ResourceId, 60.0 * mult / renew.intervalToSpawnResources * amount);
                watered = seed.maxWaterBalls > 0 && plot.HasWater;
            }
            if (!watered) return;

            int water = WaterId(farm);
            if (water != int.MinValue && seed.waterBallDuration > 0)
            {
                double per = 60.0 / seed.waterBallDuration;
                if (farm != null && farm.duplicateWaterBalls) per /= 2; // Irrigation Efficiency
                Add(In, water, per);
            }
            if (fert != null && fert.fertilizerDuration > 0) Add(In, fert.ResourceId, 60.0 / fert.fertilizerDuration);
        }

        int WaterId(AdvancedFarmPlotBuilding farm)
        {
            if (farm != null && farm.waterBallReferenceResource != null) return farm.waterBallReferenceResource.ResourceId;
            if (waterId != int.MinValue) return waterId;
            var list = ResourcesList.Instance?.Resources;
            if (list != null)
                for (int i = 0; i < list.Count; i++)
                    if (list[i] != null && list[i].name == "WaterBallResource") { waterId = list[i].ResourceId; break; }
            return waterId;
        }

        void Generator(EnergyGenerationBuilding g)
        {
            if (!g.useFuel || g.fuel == null) return;
            if (!Active(g.Pointer, g.currentFuelDuration, g.consumingFuel)) return;
            float d = g.fuelDuration * (1 + g.productionEfficiencyBonus); // = FuelDuration getter (protected)
            if (d > 0) Add(In, g.fuel.ResourceId, 60.0 / d);
        }
    }
}
