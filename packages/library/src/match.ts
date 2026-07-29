/**
 * Title matching — "is this the same work?" for entries that carry no shared external id.
 *
 * The library's preferred cross-source signal is `externalIds` (see `Library.addSeries`'s auto-link),
 * but plenty of payloads never carry one: a bridge's `favorites` list is `SeriesEntry` — id, title,
 * thumbnail, nothing else. For those the title is all there is, so this is the fallback.
 */

/**
 * Fold a title down to a comparison key: fullwidth/compatibility forms folded, Latin diacritics
 * dropped, lowercased, then everything that isn't a letter or a digit removed (any script — CJK
 * titles keep their characters).
 *
 * Deliberately NOT fuzzy, and deliberately no clever suffix stripping: `"Chainsaw-Man!"` matches
 * `"Chainsaw Man"`, but `"Berserk (2016)"` does NOT match `"Berserk"`. A false merge silently
 * conflates two different series, while a missed one just means the user adds it themselves — so
 * this errs hard toward missing. Callers surface matches as a suggestion for the user to confirm,
 * never as an automatic merge.
 *
 * Returns "" for a title with no alphanumeric content; callers must treat that as "no key" rather
 * than matching every other punctuation-only title to it.
 */
export function normalizeTitle(title: string): string {
  return (
    title
      .normalize("NFKD")
      // Combining Diacritical Marks ONLY (é → e), never `\p{M}` wholesale: NFKD also decomposes
      // Japanese dakuten/handakuten into U+3099/U+309A, and stripping those would fold ベ→ヘ and
      // パ→ハ — silently merging genuinely different titles. The NFC recompose puts kana back.
      .replace(/[̀-ͯ]/g, "")
      .normalize("NFC")
      .toLowerCase()
      // The one non-letter routinely used AS a letter in a title ("SPY×FAMILY" ≡ "Spy x Family").
      // Everything else that isn't alphanumeric is punctuation and simply goes.
      .replace(/[×✕✖]/g, "x")
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}
