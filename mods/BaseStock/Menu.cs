// F10 settings menu: a panel in the middle of the HUD canvas. Click a row (or its >) = next value, < or right click =
// previous, mouse wheel over a row = step. Values are MelonPreferences entries, saved when the menu closes.
// Clicks are hit-tested here (RectTransformUtility), not through the game's EventSystem. Labels: Russian when the
// game runs in Russian (a game string contains Cyrillic), otherwise English.
using System;
using System.Collections.Generic;
using System.Globalization;
using MelonLoader;
using UnityEngine;
using UnityEngine.UI;
using Il2Cpp;
using Il2CppTMPro;

namespace BaseStock
{
    public partial class BaseStockMod
    {
        bool menuOpen;
        RectTransform menuRoot;
        Canvas menuCanvas;
        bool ru;

        class Option { public string key; public Func<string> value; public Action<int> change; }
        class MenuRow { public RectTransform rt, prev, next; public Image bg; public TextMeshProUGUI label, value; public Option opt; }
        readonly List<MenuRow> menuRows = new();
        List<Option> options;

        static readonly Dictionary<string, (string en, string ru)> Texts = new()
        {
            ["title"] = ("BaseStock settings", "Настройки BaseStock"),
            ["hint"] = ("click / wheel — change   F9 — mode   Alt — other scope   F10 — close",
                        "клик / колесо — изменить   F9 — режим   Alt — другой режим   F10 — закрыть"),
            ["mode"] = ("Mode", "Режим"),
            ["modeIsland"] = ("current island", "текущий остров"),
            ["modeAll"] = ("all islands", "все острова"),
            ["modeOff"] = ("off", "выключено"),
            ["rates"] = ("Income / consumption", "Приход / расход"),
            ["ratesNet"] = ("net", "разница"),
            ["ratesBoth"] = ("both", "приход и расход"),
            ["ratesOff"] = ("hidden", "не показывать"),
            ["source"] = ("Count rates for", "Считать приход/расход"),
            ["sourceSynth"] = ("all placed buildings", "все поставленные здания"),
            ["sourceReal"] = ("working buildings only", "только работающие"),
            ["unit"] = ("Rate unit", "Единицы"),
            ["unitMinute"] = ("per minute", "в минуту"),
            ["unitHourly"] = ("per hour", "в час"),
            ["unitMin"] = ("/min", "/мин"),
            ["unitHour"] = ("/h", "/ч"),
            ["names"] = ("Item names", "Названия предметов"),
            ["sort"] = ("Sort", "Сортировка"),
            ["sortTier"] = ("by tier", "по тирам"),
            ["sortAlpha"] = ("by name", "по алфавиту"),
            ["size"] = ("Size", "Размер"),
            ["count"] = ("Count items in", "Считать предметы"),
            ["countAll"] = ("containers + buildings", "контейнеры и здания"),
            ["countCont"] = ("containers only", "только контейнеры"),
            ["hide"] = ("Hide with open windows", "Прятать при открытых окнах"),
            ["bg"] = ("Background", "Фон"),
            ["top"] = ("Top margin", "Отступ сверху"),
            ["bottom"] = ("Bottom margin", "Отступ снизу"),
            ["yes"] = ("yes", "да"),
            ["no"] = ("no", "нет"),
        };

        string T(string key) => Texts.TryGetValue(key, out var t) ? (ru ? t.ru : t.en) : key;

        void DetectLanguage()
        {
            try
            {
                string s = StringTable.GetText("Furnace_BUILDING_NAME", "") ?? "";
                ru = false;
                foreach (char c in s) if (c >= 'Ѐ' && c <= 'ӿ') { ru = true; break; }
            }
            catch { ru = false; }
        }

        static string Cycle(string cur, string[] values, int dir)
        {
            int i = Array.IndexOf(values, cur?.Trim().ToLowerInvariant());
            if (i < 0) i = 0;
            return values[((i + dir) % values.Length + values.Length) % values.Length];
        }

        static float Step(float v, int dir, float step, float min, float max) =>
            Mathf.Clamp(Mathf.Round((v + dir * step) / step) * step, min, max);

        string YesNo(bool b) => T(b ? "yes" : "no");

        List<Option> BuildOptions() => new()
        {
            new Option { key = "mode", value = () => T(new[] { "modeIsland", "modeAll", "modeOff" }[Mode]),
                         change = d => mode.Value = Cycle(mode.Value, ModeNames, d) },
            new Option { key = "rates", value = () => T(new[] { "ratesOff", "ratesNet", "ratesBoth" }[RateMode]),
                         change = d => rateMode.Value = Cycle(rateMode.Value, new[] { "net", "both", "off" }, d) },
            new Option { key = "source", value = () => T(RealRates ? "sourceReal" : "sourceSynth"),
                         change = d => rateSource.Value = Cycle(rateSource.Value, new[] { "synthetic", "real" }, d) },
            new Option { key = "unit", value = () => T(RateFactor > 1 ? "unitHourly" : "unitMinute"),
                         change = d => rateUnit.Value = Cycle(rateUnit.Value, new[] { "minute", "hour" }, d) },
            new Option { key = "names", value = () => YesNo(showNames.Value), change = d => showNames.Value = !showNames.Value },
            new Option { key = "sort", value = () => T(BySort == 1 ? "sortTier" : "sortAlpha"),
                         change = d => sortMode.Value = Cycle(sortMode.Value, new[] { "tier", "alpha" }, d) },
            new Option { key = "size", value = () => Mathf.RoundToInt(Scale * 100) + "%",
                         change = d => scale.Value = Step(Scale, d, 0.1f, 0.5f, 3f) },
            new Option { key = "count", value = () => T(countBuildingInventories.Value ? "countAll" : "countCont"),
                         change = d => countBuildingInventories.Value = !countBuildingInventories.Value },
            new Option { key = "hide", value = () => YesNo(hideWithPopups.Value), change = d => hideWithPopups.Value = !hideWithPopups.Value },
            new Option { key = "bg", value = () => Mathf.RoundToInt(backgroundAlpha.Value * 100) + "%",
                         change = d => backgroundAlpha.Value = Step(backgroundAlpha.Value, d, 0.1f, 0f, 1f) },
            new Option { key = "top", value = () => topMargin.Value.ToString("0", CultureInfo.InvariantCulture),
                         change = d => topMargin.Value = Step(topMargin.Value, d, 5f, 0f, 600f) },
            new Option { key = "bottom", value = () => bottomMargin.Value.ToString("0", CultureInfo.InvariantCulture),
                         change = d => bottomMargin.Value = Step(bottomMargin.Value, d, 5f, 0f, 600f) },
        };

        void ToggleMenu()
        {
            if (menuOpen)
            {
                menuOpen = false;
                if (menuRoot != null) menuRoot.gameObject.SetActive(false);
                try { cat.SaveToFile(false); } catch (Exception e) { LoggerInstance.Warning("save prefs: " + e.Message); }
                return;
            }
            var hud = HUDManager.Instance;
            if (hud == null || hud.mainCanvas == null) return;
            if (font == null && !BuildUI(hud)) return;
            DetectLanguage();
            if (menuRoot == null) BuildMenu(hud.mainCanvas);
            foreach (var r in menuRows) r.label.text = T(r.opt.key);
            menuTitle.text = T("title"); menuHint.text = T("hint");
            menuRoot.gameObject.SetActive(true);
            menuRoot.SetAsLastSibling();
            menuOpen = true;
            RefreshMenuValues();
        }

        TextMeshProUGUI menuTitle, menuHint;
        const float MW = 660, MRow = 30, MPad = 14;

        void BuildMenu(Canvas canvas)
        {
            menuCanvas = canvas;
            menuRows.Clear();
            options = BuildOptions();
            var go = new GameObject("BaseStockMenu");
            go.layer = canvas.gameObject.layer;
            menuRoot = go.AddComponent<RectTransform>();
            menuRoot.SetParent(canvas.transform, false);
            menuRoot.anchorMin = menuRoot.anchorMax = menuRoot.pivot = new Vector2(0.5f, 0.5f);
            float h = MPad * 2 + MRow * (options.Count + 2) + 8;
            menuRoot.sizeDelta = new Vector2(MW, h);
            menuRoot.anchoredPosition = Vector2.zero;
            var bg = go.AddComponent<Image>();
            bg.color = new Color(0.08f, 0.055f, 0.16f, 0.98f);
            bg.raycastTarget = true; // the pointer is over UI here, so the game should not act on clicks

            menuTitle = MakeText(menuRoot, "Title", TextAlignmentOptions.Center);
            Place(menuTitle.rectTransform, MPad, MPad, MW - 2 * MPad, MRow);
            menuTitle.fontSize = 22; menuTitle.color = new Color(1f, 0.91f, 0.66f);

            for (int i = 0; i < options.Count; i++)
            {
                float y = MPad + MRow * (i + 1) + 4;
                var rgo = new GameObject("Opt_" + options[i].key);
                rgo.layer = go.layer;
                var rrt = rgo.AddComponent<RectTransform>();
                rrt.SetParent(menuRoot, false);
                Place(rrt, MPad, y, MW - 2 * MPad, MRow - 2);
                var rbg = rgo.AddComponent<Image>();
                rbg.raycastTarget = true;
                rbg.color = new Color(1f, 1f, 1f, 0f);

                var label = MakeText(rrt, "Label", TextAlignmentOptions.MidlineLeft);
                Place(label.rectTransform, 8, 0, 320, MRow - 2);
                var prev = MakeText(rrt, "Prev", TextAlignmentOptions.Center); prev.richText = false; prev.text = "<";
                Place(prev.rectTransform, 330, 0, 30, MRow - 2);
                var value = MakeText(rrt, "Value", TextAlignmentOptions.Center);
                Place(value.rectTransform, 360, 0, 232, MRow - 2);
                value.color = new Color(0.49f, 0.9f, 0.42f);
                var next = MakeText(rrt, "Next", TextAlignmentOptions.Center); next.richText = false; next.text = ">";
                Place(next.rectTransform, 592, 0, 30, MRow - 2);
                foreach (var t in new[] { label, prev, value, next }) t.fontSize = 18;

                menuRows.Add(new MenuRow { rt = rrt, bg = rbg, label = label, value = value, prev = prev.rectTransform, next = next.rectTransform, opt = options[i] });
            }

            menuHint = MakeText(menuRoot, "Hint", TextAlignmentOptions.Center);
            Place(menuHint.rectTransform, MPad, MPad + MRow * (options.Count + 1) + 8, MW - 2 * MPad, MRow);
            menuHint.fontSize = 13; menuHint.color = new Color(0.75f, 0.72f, 0.9f);
            menuHint.enableWordWrapping = true;
        }

        // top-left based placement inside the parent
        static void Place(RectTransform rt, float x, float y, float w, float h)
        {
            rt.anchorMin = rt.anchorMax = new Vector2(0, 1);
            rt.pivot = new Vector2(0, 1);
            rt.anchoredPosition = new Vector2(x, -y);
            rt.sizeDelta = new Vector2(w, h);
        }

        void RefreshMenuValues()
        {
            foreach (var r in menuRows) r.value.text = r.opt.value();
        }

        void UpdateMenu()
        {
            if (!menuOpen) return;
            if (menuRoot == null) { menuOpen = false; return; } // HUD was rebuilt (scene change)
            Camera cam = menuCanvas != null && menuCanvas.renderMode != RenderMode.ScreenSpaceOverlay ? menuCanvas.worldCamera : null;
            Vector2 mouse = Input.mousePosition;
            bool l = Input.GetMouseButtonDown(0), r = Input.GetMouseButtonDown(1);
            float wheel = Input.mouseScrollDelta.y;
            foreach (var row in menuRows)
            {
                bool over = RectTransformUtility.RectangleContainsScreenPoint(row.rt, mouse, cam);
                row.bg.color = new Color(1f, 1f, 1f, over ? 0.10f : 0f);
                if (!over) continue;
                int dir = 0;
                if (l) dir = RectTransformUtility.RectangleContainsScreenPoint(row.prev, mouse, cam) ? -1 : 1;
                else if (r) dir = -1;
                else if (wheel > 0.01f) dir = 1;
                else if (wheel < -0.01f) dir = -1;
                if (dir != 0)
                {
                    row.opt.change(dir);
                    RefreshMenuValues();
                    timer = 0; // re-layout the list right away
                    foreach (var x in rows) x.value = -1;
                }
            }
        }
    }
}
