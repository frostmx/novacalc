// All visible text goes through localization keys: game keys (data/locale/<lang>.json, extracted from the game)
// plus UI keys (app/locale/<lang>.json). Adding a language = adding both files.
let table = {};

export async function loadLocale(lang) {
  const [game, ui] = await Promise.all([
    fetchJson(`../data/locale/${lang}.json`),
    fetchJson(`./locale/${lang}.json`),
  ]);
  table = { ...game, ...ui };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Text for `key` with {0}, {1}… substituted, or null when the key is missing. */
export function t(key, ...args) {
  const s = table[key];
  if (s == null) return null;
  return s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
}

/** Same as t(), but falls back to the key itself so a missing string is visible, not blank. */
export function tk(key, ...args) {
  return t(key, ...args) ?? key;
}

/** Strip Unity rich-text tags (<color=…>, <sprite …>) from game strings. */
export function plain(s) {
  return s == null ? null : s.replace(/<[^>]*>/g, '').trim();
}

export function applyStaticTexts(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tk(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = tk(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = tk(el.dataset.i18nTitle);
}
