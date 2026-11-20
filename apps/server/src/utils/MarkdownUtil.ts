/** Markdown escaping for /llms.txt. */
export class MarkdownUtil {
  /**
   * Collapses whitespace to a single space and escapes the two characters that
   * would break a markdown link label.
   *
   * @param text - Untrusted text.
   * @returns One line, safe inside `[...]`.
   */
  static escapeMarkdownText(text: string): string {
    return text.replace(/\s+/g, " ").trim().replace(/\[/g, "\\[").replace(/\]/g, "\\]")
  }
}
