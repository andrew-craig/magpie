// Utility for truncating oversized text (e.g. a large diff or PR body) to a
// bounded number of lines before it is logged or embedded in a comment, so a
// pathological input can't blow up log volume or a GitHub comment body.

/** Marker appended when text is truncated, so readers know output was cut. */
const TRUNCATION_MARKER = "… (truncated)";

/**
 * Truncate `text` to at most `maxLines` lines. If the text is longer, the
 * kept portion is followed by a marker line indicating truncation.
 *
 * @param text     the (possibly large) input text
 * @param maxLines maximum number of lines to keep
 */
export function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");

  if (lines.length < maxLines) {
    return text;
  }

  const kept = lines.slice(0, maxLines);
  kept.push(TRUNCATION_MARKER);
  return kept.join("\n");
}
