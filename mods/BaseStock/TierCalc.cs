// Item progression levels computed in the running game from its research graph — the same algorithm as
// tools/item_tiers.py, so new items (game patch, other mods) get a level without regenerating ItemTiers.cs:
//   research level    = 1 + max(levels of required researches, levels of the items it costs)
//   recipe / building = 0 if startUnlocked (or a recipe no research unlocks), else the lowest level of a research
//                       unlocking it
//   item level        = lowest over the recipes producing it of max(recipe, building, its inputs' levels);
//                       mega furnaces (ContinuousProductionBuilding, credit-bought shortcut) and the Animal Cloning
//                       Machine are skipped
//   raw item          = (no producing recipe) half a level before its first consumer (research cost / recipe input)
//   hard drive        = Inventor hard drive researches (HardDriveResearch*, or IsHardDrive) have no requirements or costs
//                       in the data — they come with spacewalks — so they get HardDriveLevel, above every tier bound:
//                       their recipes land in the last tier. A drive as a requirement of another research (the
//                       Inventor hands out inventions and drives in turn) is ignored.
// Sources: ResearchesList.Researches, RecipesList.Recipes (startUnlocked), BuildingsList.Buildings (prefabs:
// startUnlocked, availableRecipes of production buildings and the Advanced Farm), ResourcesList.Resources.
using System;
using System.Collections.Generic;
using Il2Cpp;
using Il2CppInterop.Runtime;

namespace BaseStock
{
    public static class TierCalc
    {
        const double INF = 1e9;
        const int CLONING = 439;
        const double HardDriveLevel = 100;

        class Recipe { public int id; public List<int> inputs = new(); public List<int> outputs = new(); }
        class Research { public bool hardDrive; public List<IntPtr> req = new(); public List<int> cost = new(); public List<int> recipes = new(); public List<int> buildings = new(); }

        public static Dictionary<int, float> Compute(out string summary)
        {
            var rl = ResourcesList.Instance; var recl = RecipesList.Instance; var bl = BuildingsList.Instance; var resl = ResearchesList.Instance;
            if (rl == null || recl == null || bl == null || resl == null) { summary = "lists not ready"; return null; }

            var items = new List<int>();
            var res = rl.Resources;
            for (int i = 0; i < res.Count; i++) if (res[i] != null) items.Add(res[i].ResourceId);

            var recipes = new Dictionary<int, Recipe>();
            var recStart = new HashSet<int>();
            var rlist = recl.Recipes;
            for (int i = 0; i < rlist.Count; i++)
            {
                var r = rlist[i];
                if (r == null || recipes.ContainsKey(r.recipeId)) continue;
                recipes[r.recipeId] = ToRecipe(r);
                if (r.startUnlocked) recStart.Add(r.recipeId);
            }

            var researches = new Dictionary<IntPtr, Research>();
            var researchUnlocked = new HashSet<int>();
            var all = resl.Researches;
            for (int i = 0; i < all.Count; i++)
            {
                var d = all[i];
                if (d == null || researches.ContainsKey(d.Pointer)) continue;
                string rname = d.name ?? "";
                var x = new Research { hardDrive = rname.Contains("HardDrive") || d.isHardDrive };
                var req = d.requirement;
                if (req != null) for (int k = 0; k < req.Count; k++) if (req[k] != null) x.req.Add(req[k].Pointer);
                var cost = d.researchCost;
                if (cost != null) for (int k = 0; k < cost.Count; k++) if (cost[k]?.resource != null) x.cost.Add(cost[k].resource.ResourceId);
                var ur = d.unlockedRecipes;
                if (ur != null) for (int k = 0; k < ur.Count; k++) if (ur[k] != null)
                {
                    x.recipes.Add(ur[k].recipeId); researchUnlocked.Add(ur[k].recipeId);
                    if (!recipes.ContainsKey(ur[k].recipeId)) recipes[ur[k].recipeId] = ToRecipe(ur[k]);
                }
                var ub = d.unlockedBuildings;
                if (ub != null) for (int k = 0; k < ub.Count; k++) if (ub[k] != null) x.buildings.Add(ub[k].buildingId);
                researches[d.Pointer] = x;
            }

            // producers: item -> (recipe, building id)
            var producers = new Dictionary<int, List<(Recipe r, int b)>>();
            var bldStart = new HashSet<int>();
            var blist = bl.Buildings;
            int nBuildings = 0;
            for (int i = 0; i < blist.Count; i++)
            {
                var b = blist[i];
                if (b == null) continue;
                nBuildings++;
                if (b.startUnlocked) bldStart.Add(b.buildingId);
                if (b.buildingId == CLONING || b.TryCast<ContinuousProductionBuilding>() != null) continue;
                Il2CppSystem.Collections.Generic.List<BaseRecipe> avail = null;
                var pb = b.TryCast<BaseProductionBuilding>();
                if (pb != null) avail = pb.availableRecipes;
                else { var af = b.TryCast<AdvancedFarmPlotBuilding>(); if (af != null) avail = af.availableRecipes; }
                if (avail == null) continue;
                for (int k = 0; k < avail.Count; k++)
                {
                    var r = avail[k];
                    if (r == null) continue;
                    if (!recipes.TryGetValue(r.recipeId, out var rec)) recipes[r.recipeId] = rec = ToRecipe(r);
                    foreach (int o in rec.outputs)
                    {
                        if (!producers.TryGetValue(o, out var lst)) producers[o] = lst = new();
                        lst.Add((rec, b.buildingId));
                    }
                }
            }

            var (item, resLevel) = Solve(items, recipes, recStart, researches, researchUnlocked, producers, bldStart, null);
            var firstUse = new Dictionary<int, double>();
            void Use(int i, double v) { if (!firstUse.TryGetValue(i, out double f) || v < f) firstUse[i] = v; }
            foreach (var kv in researches) foreach (int c in kv.Value.cost) Use(c, resLevel[kv.Key]);
            foreach (var kv in producers) foreach (var (r, _) in kv.Value) foreach (int x in r.inputs) Use(x, item[kv.Key]);
            var raw = new Dictionary<int, double>();
            foreach (int i in items) if (!producers.ContainsKey(i) && firstUse.TryGetValue(i, out double f) && f < INF) raw[i] = Math.Max(0, f - 0.5);
            (item, _) = Solve(items, recipes, recStart, researches, researchUnlocked, producers, bldStart, raw);

            var outp = new Dictionary<int, float>();
            foreach (var kv in item) if (kv.Value < INF) outp[kv.Key] = (float)kv.Value;
            summary = $"{outp.Count}/{items.Count} items from {researches.Count} researches, {recipes.Count} recipes, {nBuildings} buildings";
            return outp;
        }

        static Recipe ToRecipe(BaseRecipe r)
        {
            var x = new Recipe { id = r.recipeId };
            var inp = r.input; var outp = r.output;
            if (inp != null) for (int i = 0; i < inp.Count; i++) if (inp[i]?.resource != null) x.inputs.Add(inp[i].resource.ResourceId);
            if (outp != null) for (int i = 0; i < outp.Count; i++) if (outp[i]?.resource != null) x.outputs.Add(outp[i].resource.ResourceId);
            return x;
        }

        static (Dictionary<int, double> item, Dictionary<IntPtr, double> res) Solve(
            List<int> items, Dictionary<int, Recipe> recipes, HashSet<int> recStart, Dictionary<IntPtr, Research> researches,
            HashSet<int> researchUnlocked, Dictionary<int, List<(Recipe r, int b)>> producers, HashSet<int> bldStart,
            Dictionary<int, double> raw)
        {
            var item = new Dictionary<int, double>();
            foreach (int i in items) item[i] = producers.ContainsKey(i) ? INF : (raw != null && raw.TryGetValue(i, out double v) ? v : 0);
            foreach (var kv in producers) if (!item.ContainsKey(kv.Key)) item[kv.Key] = INF;
            double Item(int i) => item.TryGetValue(i, out double v) ? v : 0;
            var res = new Dictionary<IntPtr, double>();
            foreach (var k in researches.Keys) res[k] = INF;

            for (int iter = 0; iter < 100; iter++)
            {
                bool changed = false;
                foreach (var kv in researches)
                {
                    double m = 0;
                    foreach (var r in kv.Value.req)
                        if (res.TryGetValue(r, out double rv) && !researches[r].hardDrive) m = Math.Max(m, rv); // drive as a requirement: ignored
                    foreach (int c in kv.Value.cost) m = Math.Max(m, Item(c));
                    double v = kv.Value.hardDrive ? HardDriveLevel : Math.Min(1 + m, INF);
                    if (v < res[kv.Key]) { res[kv.Key] = v; changed = true; }
                }
                var recUn = new Dictionary<int, double>(); var bldUn = new Dictionary<int, double>();
                foreach (int r in recStart) recUn[r] = 0;
                foreach (int b in bldStart) bldUn[b] = 0;
                foreach (var kv in researches)
                {
                    double lv = res[kv.Key];
                    foreach (int r in kv.Value.recipes) if (!recUn.TryGetValue(r, out double cur) || lv < cur) recUn[r] = lv;
                    foreach (int b in kv.Value.buildings) if (!bldUn.TryGetValue(b, out double cur) || lv < cur) bldUn[b] = lv;
                }
                foreach (var kv in producers)
                {
                    double best = INF;
                    foreach (var (r, b) in kv.Value)
                    {
                        double ru = researchUnlocked.Contains(r.id) || recStart.Contains(r.id) ? (recUn.TryGetValue(r.id, out double x) ? x : INF) : 0;
                        double v = Math.Max(ru, bldUn.TryGetValue(b, out double bu) ? bu : INF);
                        foreach (int inp in r.inputs) v = Math.Max(v, Item(inp));
                        best = Math.Min(best, v);
                    }
                    if (best < item[kv.Key]) { item[kv.Key] = best; changed = true; }
                }
                if (!changed) break;
            }
            return (item, res);
        }
    }
}
