/**
 * Debounced-search support for large option lists.
 *
 * OpenCode's DialogSelect runs fuzzysort over every option on every keystroke,
 * which is too slow for 1000+ model entries in plugin-loaded TSX. The studio
 * therefore runs searches itself: DialogSelect gets `skipFilter` plus an
 * `onFilter` callback, and after the input settles the query is scored here
 * exactly once and the option list is swapped reactively.
 *
 * Scoring mirrors DialogSelect's intent: title matches weigh double, category
 * (provider) matches weigh single; contiguous and word-start matches beat
 * scattered ones; literal substrings get a strong bonus.
 */

const NEG = Number.NEGATIVE_INFINITY

export function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 0
  if (needle.length > haystack.length) {
    // Still allow subsequence matches, but penalize longer needles.
  }
  let score = 0
  let from = 0
  let streak = 0
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, from)
    if (idx < 0) return NEG
    streak = idx === from ? streak + 1 : 0
    score += 12 + streak * 6
    const prev = idx > 0 ? haystack[idx - 1] : ""
    if (idx === 0 || /[\s\-_/.:]/.test(prev)) score += 8
    score -= Math.min(idx - from, 8)
    from = idx + 1
  }
  return score
}

export type SearchableOption = { title: string; category?: string }

export function rankOptions<T extends SearchableOption>(options: T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return options
  const exact = needle.replace(/[\s]+/g, "")
  const scored: { option: T; score: number }[] = []
  for (const option of options) {
    const title = option.title.toLowerCase()
    const category = (option.category ?? "").toLowerCase()
    const titleScore = fuzzyScore(needle, title)
    const catScore = category ? fuzzyScore(needle, category) : NEG
    let score: number
    if (titleScore === NEG && catScore === NEG) continue
    score = (titleScore === NEG ? 0 : titleScore * 2) + (catScore === NEG ? 0 : catScore)
    if (title.includes(needle)) score += 50
    if (category && category.includes(needle)) score += 15
    if (exact && title.replace(/[\s\-_/.:]/g, "").includes(exact)) score += 25
    scored.push({ option, score })
  }
  scored.sort((a, b) => b.score - a.score || a.option.title.localeCompare(b.option.title))
  return scored.map((entry) => entry.option)
}
