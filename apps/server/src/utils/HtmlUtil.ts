/** HTML escaping for pages built by hand. */
export class HtmlUtil {
  /**
   * Escapes text for an HTML text node or a double-quoted attribute.
   *
   * @param text - Untrusted text.
   * @returns The text with `&`, `<` and `"` escaped.
   */
  static escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  }
}
