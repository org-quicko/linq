import { describe, expect, test } from "bun:test"
import type { QR_PATTERNS } from "@linq/shared"
import { qrOptions } from "../lib/qr.ts"

const config = (pattern: (typeof QR_PATTERNS)[number]) => ({
  shortUrl: "https://lnq.to/abc",
  dotColor: "#123456",
  bgColor: "#ffffff",
  pattern,
})

describe("qrOptions", () => {
  test("encodes the short URL at error correction Q with no margin", () => {
    const options = qrOptions(config("squares"), 256)
    expect(options.data).toBe("https://lnq.to/abc")
    expect(options.qrOptions?.errorCorrectionLevel).toBe("Q")
    expect(options.margin).toBe(0)
    expect(options.width).toBe(256)
    expect(options.height).toBe(256)
  })

  test("each pattern maps to its own dot / corner-square / corner-dot triple", () => {
    expect(qrOptions(config("squares"), 100)).toMatchObject({
      dotsOptions: { type: "square" },
      cornersSquareOptions: { type: "square" },
      cornersDotOptions: { type: "square" },
    })
    expect(qrOptions(config("rounded"), 100)).toMatchObject({
      dotsOptions: { type: "rounded" },
      cornersSquareOptions: { type: "extra-rounded" },
      cornersDotOptions: { type: "dot" },
    })
    expect(qrOptions(config("dots"), 100)).toMatchObject({
      dotsOptions: { type: "dots" },
      cornersSquareOptions: { type: "dot" },
      cornersDotOptions: { type: "dot" },
    })
  })

  test("the dot colour drives the corners too, so a code is never two-tone", () => {
    const options = qrOptions({ ...config("dots"), dotColor: "#abcdef" }, 100)
    expect(options.dotsOptions?.color).toBe("#abcdef")
    expect(options.cornersSquareOptions?.color).toBe("#abcdef")
    expect(options.cornersDotOptions?.color).toBe("#abcdef")
    expect(options.backgroundOptions?.color).toBe("#ffffff")
  })
})
