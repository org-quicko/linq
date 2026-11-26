import { describe, expect, test } from "bun:test"
import { LINK_TREE_ACCENTS, type LinkTreePage, LinkTreeUtil } from "@linq/shared"

const PAGE: LinkTreePage = {
  title: "Ada",
  description: null,
  image_url: null,
  appearance: "auto",
  accent: "#2563eb",
  button_style: "filled",
  items: [{ label: "Blog", url: "/blog" }],
}

describe("LinkTreeUtil.renderPage", () => {
  test("is one script-free document with the settings on the root element", () => {
    const html = LinkTreeUtil.renderPage(PAGE)
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).not.toContain("<script")
    expect(html).toContain('data-appearance="auto"')
    expect(html).toContain('data-style="filled"')
    expect(html).toContain("--accent:#2563eb;--on-accent:#ffffff")
  })

  test("plays the entrance only when asked", () => {
    const root = (html: string) => html.slice(0, html.indexOf("<head>"))
    expect(root(LinkTreeUtil.renderPage(PAGE))).not.toContain("data-animate")
    expect(root(LinkTreeUtil.renderPage(PAGE, { animate: true }))).toContain("data-animate")
  })

  test("shows a monogram without an image, and the image when there is one", () => {
    expect(LinkTreeUtil.renderPage(PAGE)).toContain('class="avatar monogram" aria-hidden="true">A<')
    const withImage = LinkTreeUtil.renderPage({ ...PAGE, image_url: "https://x.test/a.png" })
    expect(withImage).toContain('<img class="avatar" src="https://x.test/a.png"')
    expect(withImage).toContain('<meta property="og:image" content="https://x.test/a.png">')
  })

  test("omits the list when there are no Items", () => {
    expect(LinkTreeUtil.renderPage({ ...PAGE, items: [] })).not.toContain("<ul>")
  })

  test("falls back to the default accent rather than injecting an invalid one", () => {
    const html = LinkTreeUtil.renderPage({ ...PAGE, accent: "red;}body{display:none" })
    expect(html).toContain("--accent:#171717")
    expect(html).not.toContain("display:none")
  })

  test("escapes text and attributes", () => {
    const html = LinkTreeUtil.renderPage({
      ...PAGE,
      title: `<b>"Ada"</b>`,
      items: [{ label: "<i>x</i>", url: `/a" onclick="x` }],
    })
    expect(html).toContain("&lt;b&gt;&quot;Ada&quot;&lt;/b&gt;")
    expect(html).toContain('href="/a&quot; onclick=&quot;x"')
  })
})

describe("LinkTreeUtil contrast", () => {
  test("picks white on dark accents and near-black on light ones", () => {
    expect(LinkTreeUtil.contrastText("#171717")).toBe("#ffffff")
    expect(LinkTreeUtil.contrastText("#fde047")).toBe("#0a0a0a")
  })

  test("every curated accent carries its text at WCAG AA or better", () => {
    for (const accent of LINK_TREE_ACCENTS) {
      const ratio = LinkTreeUtil.contrastRatio(accent, LinkTreeUtil.contrastText(accent))
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    }
  })
})
