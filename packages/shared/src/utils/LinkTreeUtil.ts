import type { LinkTreePage } from "../types/index.ts"

/**
 * The Link Tree page, as one self-contained HTML document: no script, no
 * external stylesheet or font, so the redirect host serves it in one response
 * and a strict CSP holds. The server renders it for visitors and the Client UI
 * renders the same string into its preview, so the two can never drift.
 */
export class LinkTreeUtil {
  /**
   * Renders a Link Tree page.
   *
   * @param page - What the page shows.
   * @param options - `url` is the page's own absolute address, for Open Graph;
   *   `animate` plays the one-time entrance (off in the editor preview, which
   *   re-renders on every keystroke).
   * @returns A complete HTML document.
   */
  static renderPage(page: LinkTreePage, options: { url?: string; animate?: boolean } = {}): string {
    const e = LinkTreeUtil.escape
    const title = e(page.title)
    const description = page.description ? e(page.description) : ""
    const accent = LinkTreeUtil.isHex(page.accent) ? page.accent.toLowerCase() : "#171717"
    const onAccent = LinkTreeUtil.contrastText(accent)
    const monogram = e(Array.from(page.title.trim())[0]?.toUpperCase() ?? "")

    const avatar = page.image_url
      ? `<img class="avatar" src="${e(page.image_url)}" alt="" width="88" height="88">`
      : `<div class="avatar monogram" aria-hidden="true">${monogram}</div>`

    const items = page.items
      .map(
        (item, i) =>
          `<li style="--i:${i + 2}"><a class="item" href="${e(item.url)}">${e(item.label)}</a></li>`,
      )
      .join("")

    const meta = [
      `<meta property="og:type" content="profile">`,
      `<meta property="og:title" content="${title}">`,
      description ? `<meta name="description" content="${description}">` : "",
      description ? `<meta property="og:description" content="${description}">` : "",
      page.image_url ? `<meta property="og:image" content="${e(page.image_url)}">` : "",
      options.url ? `<meta property="og:url" content="${e(options.url)}">` : "",
      `<meta name="twitter:card" content="summary">`,
    ].join("")

    return (
      `<!doctype html><html lang="en" data-appearance="${page.appearance}" data-style="${page.button_style}"${options.animate ? " data-animate" : ""}>` +
      `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>${meta}` +
      `<style>:root{--accent:${accent};--on-accent:${onAccent}}${LinkTreeUtil.CSS}</style></head>` +
      `<body><main><header style="--i:0">${avatar}<h1>${title}</h1>` +
      (description ? `<p>${description}</p>` : "") +
      `</header>` +
      (items ? `<ul>${items}</ul>` : "") +
      `</main></body></html>`
    )
  }

  /**
   * The text colour that reads best on an accent: near-black or white,
   * whichever has the higher WCAG contrast ratio against it.
   *
   * @param hex - A `#rrggbb` colour.
   * @returns `#0a0a0a` or `#ffffff`.
   */
  static contrastText(hex: string): "#0a0a0a" | "#ffffff" {
    const l = LinkTreeUtil.luminance(hex)
    const onBlack = (l + 0.05) / (LinkTreeUtil.luminance("#0a0a0a") + 0.05)
    const onWhite = 1.05 / (l + 0.05)
    return onBlack >= onWhite ? "#0a0a0a" : "#ffffff"
  }

  /**
   * The WCAG contrast ratio between two colours, from 1 to 21.
   *
   * @param a - A `#rrggbb` colour.
   * @param b - Another `#rrggbb` colour.
   * @returns The ratio; 4.5 is the floor for body text.
   */
  static contrastRatio(a: string, b: string): number {
    const [hi, lo] = [LinkTreeUtil.luminance(a), LinkTreeUtil.luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  /** Escapes text for an HTML text node or a double-quoted attribute. */
  private static escape(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  private static isHex(value: string): boolean {
    return /^#[0-9a-fA-F]{6}$/.test(value)
  }

  /** Relative luminance, per WCAG 2. */
  private static luminance(hex: string): number {
    const channel = (offset: number) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }

  /**
   * Neutral surfaces in both schemes, with the accent confined to the avatar and
   * the Items. Motion: Items press to 0.97 and ease back (160ms, strong
   * ease-out); the entrance rises 8px with a short stagger, only on the live
   * page, and never under reduced motion. Hover is gated to fine pointers so a
   * tap never leaves a stuck hover state.
   */
  private static readonly CSS = `
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#525252;--card:#ffffff;--line:#e5e5e5;--ease:cubic-bezier(.23,1,.32,1);color-scheme:light}
:root[data-appearance=dark]{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--card:#171717;--line:#262626;color-scheme:dark}
@media (prefers-color-scheme:dark){:root[data-appearance=auto]{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--card:#171717;--line:#262626;color-scheme:dark}}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%}
body{font:400 15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{display:flex;flex-direction:column;gap:32px;width:100%;max-width:560px;min-height:100dvh;margin:0 auto;padding:64px 20px 48px}
header{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center}
.avatar{width:88px;height:88px;border-radius:50%;object-fit:cover;background:var(--line)}
.monogram{display:grid;place-items:center;background:var(--accent);color:var(--on-accent);font-size:34px;font-weight:600}
h1{margin-top:4px;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.01em;text-wrap:balance}
header p{max-width:36ch;color:var(--muted);text-wrap:pretty}
ul{display:flex;flex-direction:column;gap:12px;list-style:none}
.item{display:flex;align-items:center;justify-content:center;min-height:52px;padding:14px 20px;border:1.5px solid transparent;border-radius:14px;font-weight:500;text-align:center;text-decoration:none;overflow-wrap:anywhere;-webkit-tap-highlight-color:transparent;transition:transform 160ms var(--ease),background-color 150ms ease,border-color 150ms ease}
[data-style=filled] .item{background:var(--accent);color:var(--on-accent)}
[data-style=outline] .item{border-color:var(--accent);color:var(--fg)}
[data-style=soft] .item{background:color-mix(in oklab,var(--accent) 14%,var(--card));color:var(--fg)}
.item:active{transform:scale(.97)}
.item:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media (hover:hover) and (pointer:fine){
[data-style=filled] .item:hover{background:color-mix(in oklab,var(--accent) 88%,var(--fg))}
[data-style=outline] .item:hover{background:color-mix(in oklab,var(--accent) 8%,transparent)}
[data-style=soft] .item:hover{background:color-mix(in oklab,var(--accent) 22%,var(--card))}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
[data-animate] header,[data-animate] li{animation:rise 400ms var(--ease) both;animation-delay:calc(min(var(--i),10) * 40ms)}
@media (prefers-reduced-motion:reduce){[data-animate] header,[data-animate] li{animation:none}.item{transition:background-color 150ms ease,border-color 150ms ease}.item:active{transform:none}}
`
    .trim()
    .replace(/\n/g, "")
}
