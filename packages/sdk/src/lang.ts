/**
 * Language-name → short badge abbreviation.
 *
 * Multi-language sources tag each item with a full language name ("English", "japanese"), which is
 * far too long for a card chip. Bridges that surface a language badge want the terse two-letter form
 * instead, and every one of them would otherwise carry its own copy of this table.
 */
const LANGUAGE_ABBREVIATIONS: Record<string, string> = {
  english: "EN",
  japanese: "JP",
  chinese: "CN",
  korean: "KR",
  spanish: "ES",
  french: "FR",
  german: "DE",
  russian: "RU",
  portuguese: "PT",
  italian: "IT",
  dutch: "NL",
  polish: "PL",
  vietnamese: "VN",
  thai: "TH",
  indonesian: "ID",
  tagalog: "TL",
  arabic: "AR",
  hungarian: "HU",
  czech: "CS",
  turkish: "TR",
  ukrainian: "UA",
};

/**
 * Abbreviate a language name (any case, e.g. `"English"`, `"japanese"`) to a short uppercase code
 * for a card badge (`"EN"`, `"JP"`). A language not in the table falls back to its first two letters
 * uppercased, so an unknown language still renders a compact chip rather than its full name.
 */
export function abbreviateLanguage(name: string): string {
  const key = name.trim().toLowerCase();
  return LANGUAGE_ABBREVIATIONS[key] ?? key.slice(0, 2).toUpperCase();
}
