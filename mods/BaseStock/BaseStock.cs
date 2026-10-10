// BaseStock — Nova Lands mod (MelonLoader, IL2CPP): on the right side of the HUD, every item held by the buildings
// (containers + factory inputs/outputs) of the current island, sorted by game progression in tier groups, with its count
// and synthetic income / consumption. Rows per column follow the screen height; when a column is full a new one starts.
// F9 cycles island → all islands → off; holding Alt shows the other scope (all islands when off); F10 = settings menu.
//
// Game facts this relies on (from GameAssembly.dll):
//  - container content lives in its popup: BaseContainer.popup (BaseContainerPopup).inventory (InventoryWindow),
//    InventoryWindow.GetInventoryContent() → resourceId → count (that is what BaseContainer.GetResourceCount reads);
//  - WorldArea.allItemsCount is NOT used: it only counts containers marked as a logistics source
//    (BaseContainerPopup.OnChangeItemsCount updates it only when container.IsResourceSource), plus ground items;
//  - WorldUpdateManager.CurrentPlayerArea = island the player is on, WorldManager.GetWorldAreasList() = all;
//  - ResourcesList.GetResource(id) → ResourceName (localized) + sprite; island name = StringTable "<Biome>_NAME".
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using MelonLoader;
using UnityEngine;
using UnityEngine.UI;
using Il2Cpp;
using Il2CppTMPro;

[assembly: MelonInfo(typeof(BaseStock.BaseStockMod), "BaseStock", "1.0.0", "frost")]
[assembly: MelonGame("BEHEMUTT", "Nova Lands")]

namespace BaseStock
{
    public partial class BaseStockMod : MelonMod
    {
        MelonPreferences_Category cat;
        MelonPreferences_Entry<KeyCode> scopeKey, peekKey, menuKey;
        MelonPreferences_Entry<bool> showNames, hideWithPopups, countBuildingInventories;
        MelonPreferences_Entry<float> refreshSeconds, fontSize, rowHeight, iconSize, topMargin, bottomMargin,
            rightMargin, columnGap, backgroundAlpha, scale;
        MelonPreferences_Entry<string> mode, rateUnit;

        float timer;
        bool peeking;                                    // peek key held: show the other scope
        // mode: 0 island, 1 all islands, 2 off. Alt: island <-> all, off -> all. The open menu shows the list too.
        int Mode => mode.Value?.Trim().ToLowerInvariant() switch { "all" => 1, "off" => 2, _ => 0 };
        static readonly string[] ModeNames = { "island", "all", "off" };
        bool ShowAll => peeking ? Mode != 1 : Mode == 1;
        bool ListVisible => peeking || Mode != 2 || menuOpen;
        float Scale => Mathf.Clamp(scale.Value, 0.5f, 3f);
        double RateFactor => rateUnit.Value?.Trim().ToLowerInvariant() == "hour" ? 60.0 : 1.0;
        RectTransform root;          // our panel, child of the HUD main canvas
        RectTransform rootParentRect; // HUD canvas rect, gives the height in canvas units
        CanvasGroup mirrorGroup;     // HUD canvas group (fades the HUD), mirrored when we are not under it
        CanvasGroup ownGroup;
        TMP_FontAsset font;
        Material fontMaterial;
        Color textColor = Color.white;

        class Row { public RectTransform rt; public Image icon; public TextMeshProUGUI name, count, rate; public int id = -1; public int value = -1; }
        readonly List<Row> rows = new();
        readonly List<Image> columnBgs = new();
        TextMeshProUGUI header;

        readonly Dictionary<int, int> counts = new();
        readonly Dictionary<int, (string name, string sortKey, Sprite sprite, bool package)> resCache = new();
        Dictionary<int, int> gameOrder;                  // ResourcesList.Resources index: the game's own item order
        static readonly Regex RichText = new("<.*?>", RegexOptions.Compiled);
        struct Entry { public int id; public int count; public double rin, rout; public string name; public string sortKey; public Sprite sprite;
            public int tier; public float level; public int order; }
        readonly List<Entry> entries = new();
        readonly Rates rates = new();
        MelonPreferences_Entry<string> rateMode, sortMode, tierBounds;
        MelonPreferences_Entry<float> separatorHeight;

        public override void OnInitializeMelon()
        {
            cat = MelonPreferences.CreateCategory("BaseStock");
            scopeKey = cat.CreateEntry("ScopeKey", KeyCode.F9, description: "Cycle mode: island -> all islands -> off");
            peekKey = cat.CreateEntry("PeekKey", KeyCode.LeftAlt,
                description: "Hold to show the other scope (island <-> all islands, off -> all); LeftAlt also accepts RightAlt");
            menuKey = cat.CreateEntry("MenuKey", KeyCode.F10, description: "Settings menu");
            mode = cat.CreateEntry("Mode", "island", description: "island | all | off");
            rateUnit = cat.CreateEntry("RateUnit", "minute", description: "minute | hour");
            scale = cat.CreateEntry("Scale", 1f, description: "Size of the list (font, icons, rows)");
            showNames = cat.CreateEntry("ShowNames", false, description: "false = icon + count only");
            hideWithPopups = cat.CreateEntry("HideWithPopups", true, description: "Hide while a building window / game popup is open");
            countBuildingInventories = cat.CreateEntry("CountBuildingInventories", true,
                description: "true = containers + inputs/outputs of all buildings; false = containers only");
            rateMode = cat.CreateEntry("RateMode", "net",
                description: "Per-minute rates from the placed buildings: net (produced − consumed) | both (+produced −consumed) | off");
            sortMode = cat.CreateEntry("SortMode", "tier",
                description: "tier = by game progression (research graph, ItemTiers.cs) in tier groups | alpha = by name");
            tierBounds = cat.CreateEntry("TierBounds", "6,10,13,16,18",
                description: "Progression levels where tiers II, III, ... start (packages always form the last group)");
            separatorHeight = cat.CreateEntry("SeparatorHeight", 5f, description: "Space taken by the thin line between tiers");
            refreshSeconds = cat.CreateEntry("RefreshSeconds", 1f);
            fontSize = cat.CreateEntry("FontSize", 18f, description: "In HUD canvas units");
            rowHeight = cat.CreateEntry("RowHeight", 22f);
            iconSize = cat.CreateEntry("IconSize", 20f);
            topMargin = cat.CreateEntry("TopMargin", 75f, description: "Space kept free above the list (money box)");
            bottomMargin = cat.CreateEntry("BottomMargin", 110f, description: "Space kept free below (tool slot)");
            rightMargin = cat.CreateEntry("RightMargin", 8f);
            columnGap = cat.CreateEntry("ColumnGap", 6f);
            backgroundAlpha = cat.CreateEntry("BackgroundAlpha", 0.72f);
        }

        public override void OnUpdate()
        {
            if (Input.GetKeyDown(scopeKey.Value)) { mode.Value = ModeNames[(Mode + 1) % 3]; timer = 0; }
            if (Input.GetKeyDown(menuKey.Value)) { ToggleMenu(); timer = 0; }
            try { UpdateMenu(); } catch (Exception e) { LoggerInstance.Error(e.ToString()); menuOpen = false; }
            bool peek = Input.GetKey(peekKey.Value) || (peekKey.Value == KeyCode.LeftAlt && Input.GetKey(KeyCode.RightAlt));
            if (peek != peeking) { peeking = peek; timer = 0; }

            if (root != null && ownGroup != null)
            {
                float a = 1f;
                if (mirrorGroup != null && !root.IsChildOf(mirrorGroup.transform)) a = mirrorGroup.alpha;
                bool blocked = false;
                try { blocked = !menuOpen && hideWithPopups.Value && PopupOpen(); } catch { }
                ownGroup.alpha = blocked ? 0f : a;
            }

            timer -= Time.unscaledDeltaTime;
            if (timer > 0) return;
            timer = Mathf.Max(0.1f, refreshSeconds.Value);
            try { Refresh(); }
            catch (Exception e) { LoggerInstance.Error(e.ToString()); timer = 5; }
        }

        // a building window the player interacts with (BasePlayer.IsInteractingWithPopup) or a PopupManager popup
        // (research, antenna, drone base, market, ...)
        bool PopupOpen()
        {
            bool building = false;
            var wm = WorldManager.Instance;
            var players = wm != null ? wm.Players : null;
            if (players != null)
                for (int i = 0; i < players.Count; i++)
                    if (players[i] != null && players[i].IsInteractingWithPopup()) { building = true; break; }
            var pm = PopupManager.Instance;
            var cur = pm != null ? pm.CurrentPopup : null;
            return building || cur != null;
        }

        void Refresh()
        {
            var hud = HUDManager.Instance;
            var wum = WorldUpdateManager.Instance;
            var rl = ResourcesList.Instance;
            WorldArea area = wum != null ? wum.CurrentPlayerArea : null;
            if (!ListVisible || hud == null || rl == null || area == null) { SetActive(false); return; }
            if (root == null && !BuildUI(hud)) return;

            // --- count ---
            counts.Clear();
            countedWindows.Clear();
            if (++cacheAge >= 30) { cacheAge = 0; windowCache.Clear(); }
            rates.Clear();
            bool withRates = RateMode != 0;
            if (ShowAll && WorldManager.Instance != null)
            {
                var areas = WorldManager.Instance.GetWorldAreasList();
                for (int i = 0; i < areas.Count; i++)
                {
                    CountArea(areas[i]);
                    if (withRates) rates.AddArea(areas[i], LogOnce);
                }
            }
            else
            {
                CountArea(area);
                if (withRates) rates.AddArea(area, LogOnce);
            }

            if (rates.OxygenInfo != null && logged.Add(rates.OxygenInfo)) LoggerInstance.Msg(rates.OxygenInfo);

            // items in stock + items that are only produced / consumed
            ids.Clear();
            foreach (var kv in counts) if (kv.Value > 0) ids.Add(kv.Key);
            foreach (var kv in rates.In) ids.Add(kv.Key);
            foreach (var kv in rates.Out) ids.Add(kv.Key);

            entries.Clear();
            foreach (int id in ids)
            {
                counts.TryGetValue(id, out int count);
                rates.In.TryGetValue(id, out double rin);
                rates.Out.TryGetValue(id, out double rout);
                if (count <= 0 && RateText(rin, rout).Length == 0) continue;
                if (!resCache.TryGetValue(id, out var info))
                {
                    var res = rl.GetResource(id);
                    string nm = res != null ? res.ResourceName : null;
                    if (string.IsNullOrEmpty(nm)) nm = res != null ? res.name : "#" + id;
                    info = (nm, RichText.Replace(nm, "").Trim(), res != null ? res.sprite : null, res != null && res.IsPackage);
                    resCache[id] = info;
                }
                var e = new Entry { id = id, count = count, rin = rin, rout = rout, name = info.name, sortKey = info.sortKey, sprite = info.sprite };
                if (BySort == 1)
                {
                    bool known = Levels(rl).TryGetValue(id, out e.level);
                    e.tier = info.package ? int.MaxValue : known ? TierOf(e.level) : int.MaxValue - 1; // unknown (new) items before packages
                    e.order = GameOrder(rl).TryGetValue(id, out int o) ? o : int.MaxValue;
                }
                entries.Add(e);
            }
            var cmp = StringComparer.Create(CultureInfo.CurrentCulture, true);
            entries.Sort((a, b) =>
            {
                int c = a.tier.CompareTo(b.tier);
                if (c == 0) c = a.level.CompareTo(b.level);
                if (c == 0) c = a.order.CompareTo(b.order);
                if (c == 0) c = cmp.Compare(a.sortKey, b.sortKey);
                return c != 0 ? c : a.id.CompareTo(b.id);
            });

            header.text = (ShowAll ? "Σ" : IslandName(area)) +
                          (RateMode != 0 ? $" <size=70%><color=#BBBBBB>{T(RateFactor > 1 ? "unitHour" : "unitMin")}</color></size>" : "");
            Layout();
            SetActive(entries.Count > 0);
        }

        readonly HashSet<int> ids = new();
        readonly HashSet<string> logged = new();
        void LogOnce(string msg) { if (logged.Add(msg)) LoggerInstance.Warning(msg); }

        int BySort => sortMode.Value?.Trim().ToLowerInvariant() == "alpha" ? 0 : 1;

        string boundsSrc; float[] bounds = Array.Empty<float>();
        int TierOf(float level)
        {
            if (boundsSrc != tierBounds.Value)
            {
                boundsSrc = tierBounds.Value;
                var list = new List<float>();
                foreach (var part in (boundsSrc ?? "").Split(','))
                    if (float.TryParse(part.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out float f)) list.Add(f);
                bounds = list.ToArray();
            }
            int t = 0;
            foreach (float b in bounds) if (level >= b) t++;
            return t;
        }

        // levels: computed in the game (TierCalc) once per session; ItemTiers.cs (tools/item_tiers.py) is the fallback
        // and the reference — differences are logged
        Dictionary<int, float> levels;
        Dictionary<int, float> Levels(ResourcesList rl)
        {
            if (levels != null) return levels;
            Dictionary<int, float> calc = null; string summary;
            try { calc = TierCalc.Compute(out summary); }
            catch (Exception ex) { summary = "failed: " + ex.Message; }
            if (calc == null || calc.Count < 50)
            {
                LoggerInstance.Warning($"tiers: in-game calculation unusable ({summary}), using ItemTiers.cs");
                return levels = ItemTiers.Level;
            }
            var diffs = new List<string>();
            foreach (var kv in calc)
                if (!ItemTiers.Level.TryGetValue(kv.Key, out float t) || Math.Abs(t - kv.Value) > 1e-3)
                    diffs.Add($"{ItemName(rl, kv.Key)} {(ItemTiers.Level.ContainsKey(kv.Key) ? ItemTiers.Level[kv.Key].ToString(CultureInfo.InvariantCulture) : "new")}->{kv.Value.ToString(CultureInfo.InvariantCulture)}");
            foreach (var kv in ItemTiers.Level)
                if (!calc.ContainsKey(kv.Key)) diffs.Add($"{ItemName(rl, kv.Key)} {kv.Value.ToString(CultureInfo.InvariantCulture)}->none");
            LoggerInstance.Msg($"tiers: computed in game, {summary}; differs from ItemTiers.cs for {diffs.Count}" +
                               (diffs.Count > 0 ? ": " + string.Join(", ", diffs.GetRange(0, Math.Min(25, diffs.Count))) : ""));
            return levels = calc;
        }

        static string ItemName(ResourcesList rl, int id)
        {
            var r = rl.GetResource(id);
            return r != null ? RichText.Replace(r.ResourceName ?? r.name, "") : "#" + id;
        }

        Dictionary<int, int> GameOrder(ResourcesList rl)
        {
            if (gameOrder != null) return gameOrder;
            gameOrder = new Dictionary<int, int>();
            var list = rl.Resources;
            if (list != null)
                for (int i = 0; i < list.Count; i++)
                    if (list[i] != null && !gameOrder.ContainsKey(list[i].ResourceId)) gameOrder[list[i].ResourceId] = i;
            return gameOrder;
        }

        int RateMode => rateMode.Value?.Trim().ToLowerInvariant() switch { "off" => 0, "both" => 2, _ => 1 };

        const string Green = "#7CE66B", Red = "#FF6B6B";

        static string FormatRate(double v)
        {
            double a = Math.Abs(v);
            return a < 10 ? a.ToString("0.0", CultureInfo.InvariantCulture) : a.ToString("N0", CultureInfo.InvariantCulture);
        }

        // "" when nothing to show (|rate| < 0.05/min)
        string RateText(double rin, double rout)
        {
            rin *= RateFactor; rout *= RateFactor;
            switch (RateMode)
            {
                case 0: return "";
                case 2:
                {
                    string s = "";
                    if (rout >= 0.05) s += $"<color={Green}>+{FormatRate(rout)}</color>";
                    if (rin >= 0.05) s += (s.Length > 0 ? " " : "") + $"<color={Red}>-{FormatRate(rin)}</color>";
                    return s;
                }
                default:
                {
                    double net = rout - rin;
                    if (Math.Abs(net) < 0.05) return (rin >= 0.05 ? "<color=#BBBBBB>0</color>" : "");
                    return net > 0 ? $"<color={Green}>+{FormatRate(net)}</color>" : $"<color={Red}>-{FormatRate(net)}</color>";
                }
            }
        }

        // Every building keeps its items in InventoryWindows inside its popup (BaseBuilding.popup): containers one,
        // production buildings input + output (+ lubricant / drill), farms seeds + fertilizer, generators fuel, ...
        // All windows under the popup are summed; with CountBuildingInventories = false only containers count.
        // The window list per building is cached (GetComponentsInChildren allocates) and rebuilt every 30 refreshes.
        readonly Dictionary<IntPtr, InventoryWindowRef[]> windowCache = new();
        readonly HashSet<IntPtr> countedWindows = new();
        int cacheAge;
        struct InventoryWindowRef { public Il2CppMuttInventory.InventoryWindow w; }

        void CountArea(WorldArea area)
        {
            if (area == null) return;
            var buildings = area.PlayerBuildings;
            if (buildings == null) return;
            bool all = countBuildingInventories.Value;
            for (int i = 0; i < buildings.Count; i++)
            {
                var b = buildings[i];
                if (b == null) continue;
                if (!all && b.TryCast<BaseContainer>() == null) continue;
                if (!windowCache.TryGetValue(b.Pointer, out var wins))
                {
                    var popup = b.popup;
                    if (popup == null) wins = Array.Empty<InventoryWindowRef>();
                    else
                    {
                        var found = popup.GetComponentsInChildren<Il2CppMuttInventory.InventoryWindow>(true);
                        wins = new InventoryWindowRef[found.Length];
                        for (int k = 0; k < found.Length; k++) wins[k] = new InventoryWindowRef { w = found[k] };
                    }
                    windowCache[b.Pointer] = wins;
                }
                foreach (var wr in wins)
                {
                    var w = wr.w;
                    if (w == null || !countedWindows.Add(w.Pointer)) continue;
                    var content = w.GetInventoryContent();
                    if (content == null) continue;
                    foreach (var kv in content)
                    {
                        if (kv.Value <= 0) continue;
                        counts.TryGetValue(kv.Key, out int n);
                        counts[kv.Key] = n + kv.Value;
                    }
                }
            }
        }

        static string IslandName(WorldArea area)
        {
            try
            {
                var biome = area.Biome;
                if (biome == null) return "";
                var s = StringTable.GetText(biome.name + "_NAME", "");
                return string.IsNullOrEmpty(s) ? biome.name : s;
            }
            catch { return ""; }
        }

        // ---------------- UI ----------------

        bool BuildUI(HUDManager hud)
        {
            var canvas = hud.mainCanvas;
            if (canvas == null) return false;
            rows.Clear(); columnBgs.Clear(); separators.Clear();

            foreach (var t in canvas.GetComponentsInChildren<TextMeshProUGUI>(true))
            {
                if (t.font == null) continue;
                font = t.font; fontMaterial = t.fontSharedMaterial; textColor = t.color;
                break;
            }
            if (font == null) return false;
            textColor = Color.white;

            var go = new GameObject("BaseStock");
            go.layer = canvas.gameObject.layer;
            root = go.AddComponent<RectTransform>();
            root.SetParent(canvas.transform, false);
            root.anchorMin = root.anchorMax = new Vector2(1, 1);
            root.pivot = new Vector2(1, 1);
            root.sizeDelta = Vector2.zero;
            root.SetAsLastSibling();
            ownGroup = go.AddComponent<CanvasGroup>();
            ownGroup.blocksRaycasts = false; ownGroup.interactable = false;
            rootParentRect = canvas.GetComponent<RectTransform>();
            mirrorGroup = hud.hudCanvasGroup;

            header = MakeText(root, "Header", TextAlignmentOptions.TopRight);
            var hrt = header.rectTransform;
            hrt.anchorMin = hrt.anchorMax = hrt.pivot = new Vector2(1, 1);
            LoggerInstance.Msg($"UI built under '{canvas.name}', font '{font.name}'");
            return true;
        }

        TextMeshProUGUI MakeText(Transform parent, string name, TextAlignmentOptions align)
        {
            var go = new GameObject(name);
            go.layer = parent.gameObject.layer;
            var rt = go.AddComponent<RectTransform>();
            rt.SetParent(parent, false);
            var t = go.AddComponent<TextMeshProUGUI>();
            t.font = font;
            if (fontMaterial != null) t.fontSharedMaterial = fontMaterial;
            t.fontSize = fontSize.Value;
            t.color = textColor;
            t.alignment = align;
            t.enableWordWrapping = false;
            t.overflowMode = TextOverflowModes.Overflow;
            t.raycastTarget = false;
            t.richText = true;
            return t;
        }

        Row GetRow(int i)
        {
            while (rows.Count <= i)
            {
                var go = new GameObject("Row" + rows.Count);
                go.layer = root.gameObject.layer;
                var rt = go.AddComponent<RectTransform>();
                rt.SetParent(root, false);
                rt.anchorMin = rt.anchorMax = new Vector2(1, 1);
                rt.pivot = new Vector2(0, 1);

                var igo = new GameObject("Icon");
                igo.layer = go.layer;
                var irt = igo.AddComponent<RectTransform>();
                irt.SetParent(rt, false);
                irt.anchorMin = irt.anchorMax = new Vector2(0, 0.5f);
                irt.pivot = new Vector2(0, 0.5f);
                var img = igo.AddComponent<Image>();
                img.preserveAspect = true; img.raycastTarget = false;

                var name = MakeText(rt, "Name", TextAlignmentOptions.MidlineLeft);
                var nrt = name.rectTransform;
                nrt.anchorMin = new Vector2(0, 0); nrt.anchorMax = new Vector2(0, 1); nrt.pivot = new Vector2(0, 0.5f);

                var count = MakeText(rt, "Count", TextAlignmentOptions.MidlineRight);
                var crt = count.rectTransform;
                crt.anchorMin = new Vector2(0, 0); crt.anchorMax = new Vector2(0, 1); crt.pivot = new Vector2(1, 0.5f);

                var rate = MakeText(rt, "Rate", TextAlignmentOptions.MidlineRight);
                var rrt = rate.rectTransform;
                rrt.anchorMin = new Vector2(1, 0); rrt.anchorMax = new Vector2(1, 1); rrt.pivot = new Vector2(1, 0.5f);

                rows.Add(new Row { rt = rt, icon = img, name = name, count = count, rate = rate });
            }
            return rows[i];
        }

        Image GetColumnBg(int j)
        {
            while (columnBgs.Count <= j)
            {
                var go = new GameObject("Column" + columnBgs.Count);
                go.layer = root.gameObject.layer;
                var rt = go.AddComponent<RectTransform>();
                rt.SetParent(root, false);
                rt.SetAsFirstSibling();
                rt.anchorMin = rt.anchorMax = new Vector2(1, 1);
                rt.pivot = new Vector2(0, 1);
                var img = go.AddComponent<Image>();
                img.raycastTarget = false;
                columnBgs.Add(img);
            }
            return columnBgs[j];
        }

        readonly List<Image> separators = new();
        Image GetSeparator(int k)
        {
            while (separators.Count <= k)
            {
                var go = new GameObject("Separator" + separators.Count);
                go.layer = root.gameObject.layer;
                var rt = go.AddComponent<RectTransform>();
                rt.SetParent(root, false);
                rt.anchorMin = rt.anchorMax = new Vector2(1, 1);
                rt.pivot = new Vector2(0, 0.5f);
                var img = go.AddComponent<Image>();
                img.raycastTarget = false;
                img.color = new Color(1f, 1f, 1f, 0.35f);
                separators.Add(img);
            }
            return separators[k];
        }

        void Layout()
        {
            float sc = Scale;
            float rowH = rowHeight.Value * sc, icon = iconSize.Value * sc, fs = fontSize.Value * sc, gap = columnGap.Value;
            float sepH = Mathf.Max(1f, separatorHeight.Value * sc);
            const float padX = 6f, padY = 4f, iconGap = 4f, countGap = 10f;

            root.anchoredPosition = new Vector2(-rightMargin.Value, -topMargin.Value);
            float canvasH = rootParentRect != null ? rootParentRect.rect.height : 1080f;
            float headerH = rowH;
            float availH = Mathf.Max(rowH, canvasH - topMargin.Value - bottomMargin.Value - headerH - 2 * padY);
            int n = entries.Count;

            // place rows top to bottom; a full column starts the next one. In tier mode a thin line separates tiers
            // (never at the top of a column).
            var colOf = new int[n]; var yOf = new float[n];
            var sepCol = new List<int>(); var sepY = new List<float>(); var colH = new List<float> { 0 };
            int col = 0; float y = 0;
            for (int i = 0; i < n; i++)
            {
                bool sep = BySort == 1 && i > 0 && entries[i].tier != entries[i - 1].tier && y > 0;
                float need = (sep ? sepH : 0) + rowH;
                if (y > 0 && y + need > availH) { col++; y = 0; sep = false; colH.Add(0); }
                if (sep) { sepCol.Add(col); sepY.Add(y + sepH / 2); y += sepH; }
                colOf[i] = col; yOf[i] = y; y += rowH; colH[col] = y;
            }
            int cols = colH.Count;

            // fill rows, measure columns
            var nameW = new float[cols]; var countW = new float[cols]; var rateW = new float[cols];
            for (int i = 0; i < n; i++)
            {
                var e = entries[i]; var r = GetRow(i);
                r.rt.gameObject.SetActive(true);
                if (r.id != e.id)
                {
                    r.id = e.id; r.value = -1;
                    r.name.text = e.name;
                    r.icon.sprite = e.sprite; r.icon.enabled = e.sprite != null;
                }
                if (r.value != e.count)
                {
                    r.value = e.count;
                    r.count.text = e.count.ToString("N0", CultureInfo.InvariantCulture);
                }
                string rt = RateText(e.rin, e.rout);
                if (r.rate.text != rt) r.rate.text = rt;
                if (r.name.fontSize != fs) { r.name.fontSize = fs; r.count.fontSize = fs; r.rate.fontSize = fs; }
                if (r.name.gameObject.activeSelf != showNames.Value) r.name.gameObject.SetActive(showNames.Value);
                int j = colOf[i];
                if (showNames.Value) nameW[j] = Mathf.Max(nameW[j], r.name.GetPreferredValues(r.name.text).x);
                countW[j] = Mathf.Max(countW[j], r.count.GetPreferredValues(r.count.text).x);
                if (rt.Length > 0) rateW[j] = Mathf.Max(rateW[j], r.rate.GetPreferredValues(rt).x);
            }
            for (int i = n; i < rows.Count; i++) { rows[i].rt.gameObject.SetActive(false); rows[i].id = -1; }

            var colW = new float[cols]; var countRight = new float[cols]; var colX = new float[cols];
            float total = 0;
            for (int j = 0; j < cols; j++)
            {
                countRight[j] = icon + iconGap + (showNames.Value ? nameW[j] + countGap : 0) + countW[j];
                colW[j] = countRight[j] + (rateW[j] > 0 ? countGap + rateW[j] : 0);
                total += colW[j] + 2 * padX;
            }
            total += gap * (cols - 1);

            // the first column sits at the right edge, the next ones go to the left
            float xRight = 0;
            var bgColor = new Color(0.10f, 0.07f, 0.20f, backgroundAlpha.Value);
            for (int j = 0; j < cols; j++)
            {
                float x = xRight - colW[j] - 2 * padX;
                colX[j] = x;
                var bg = GetColumnBg(j);
                bg.gameObject.SetActive(true);
                bg.color = bgColor;
                bg.rectTransform.anchoredPosition = new Vector2(x, -headerH);
                bg.rectTransform.sizeDelta = new Vector2(colW[j] + 2 * padX, colH[j] + 2 * padY);
                xRight = x - gap;
            }
            for (int j = cols; j < columnBgs.Count; j++) columnBgs[j].gameObject.SetActive(false);

            for (int i = 0; i < n; i++)
            {
                var r = rows[i]; int j = colOf[i];
                r.rt.anchoredPosition = new Vector2(colX[j] + padX, -headerH - padY - yOf[i]);
                r.rt.sizeDelta = new Vector2(colW[j], rowH);
                var irt = r.icon.rectTransform;
                irt.anchoredPosition = Vector2.zero; irt.sizeDelta = new Vector2(icon, icon);
                var nrt = r.name.rectTransform;
                nrt.anchoredPosition = new Vector2(icon + iconGap, 0); nrt.sizeDelta = new Vector2(nameW[j] + 2, 0);
                var crt = r.count.rectTransform;
                crt.anchoredPosition = new Vector2(countRight[j], 0); crt.sizeDelta = new Vector2(countW[j] + 2, 0);
                var rrt = r.rate.rectTransform;
                rrt.anchoredPosition = Vector2.zero; rrt.sizeDelta = new Vector2(rateW[j] + 2, 0);
            }

            for (int k = 0; k < sepCol.Count; k++)
            {
                var line = GetSeparator(k); int j = sepCol[k];
                line.gameObject.SetActive(true);
                line.rectTransform.anchoredPosition = new Vector2(colX[j] + padX, -headerH - padY - sepY[k]);
                line.rectTransform.sizeDelta = new Vector2(colW[j], 1f);
            }
            for (int k = sepCol.Count; k < separators.Count; k++) separators[k].gameObject.SetActive(false);

            header.fontSize = fs;
            var hrt = header.rectTransform;
            hrt.anchoredPosition = new Vector2(-padX, 0);
            hrt.sizeDelta = new Vector2(Mathf.Max(total, 50), headerH);
        }

        void SetActive(bool on)
        {
            if (root != null && root.gameObject.activeSelf != on) root.gameObject.SetActive(on);
        }
    }
}
