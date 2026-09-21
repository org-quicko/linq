import type { QrPattern } from "@linq/shared"
import type {
  CornerDotType,
  CornerSquareType,
  DotType,
  FileExtension,
  Options,
} from "qr-code-styling"

/**
 * The only file that knows `qr-code-styling`'s option vocabulary. The
 * *stored* config (plans/Plan_31.md §A0) stays linq's own three-pattern
 * vocabulary; this is where that maps onto the library's dots/corner-square/
 * corner-dot triple, so swapping renderers later is a change to this one file.
 */
const PATTERN_TYPES: Record<
  QrPattern,
  { dots: DotType; cornerSquare: CornerSquareType; cornerDot: CornerDotType }
> = {
  squares: { dots: "square", cornerSquare: "square", cornerDot: "square" },
  rounded: { dots: "rounded", cornerSquare: "extra-rounded", cornerDot: "dot" },
  dots: { dots: "dots", cornerSquare: "dot", cornerDot: "dot" },
}

export type QrStyleConfig = {
  shortUrl: string
  dotColor: string
  bgColor: string
  pattern: QrPattern
}

/** The options object every render — preview or download — is built from. */
export function qrOptions(config: QrStyleConfig, size: number): Options {
  const types = PATTERN_TYPES[config.pattern]
  return {
    width: size,
    height: size,
    data: config.shortUrl,
    margin: 0,
    qrOptions: { errorCorrectionLevel: "Q" },
    dotsOptions: { color: config.dotColor, type: types.dots },
    cornersSquareOptions: { color: config.dotColor, type: types.cornerSquare },
    cornersDotOptions: { color: config.dotColor, type: types.cornerDot },
    backgroundOptions: { color: config.bgColor },
  }
}

/** Builds a throwaway, never-appended instance sized for print and triggers
 *  the browser download — the dialog's preview instance is sized for screen
 *  and never used for this. */
export async function downloadQr(
  config: QrStyleConfig,
  name: string,
  extension: FileExtension,
): Promise<void> {
  const { default: QRCodeStyling } = await import("qr-code-styling")
  const instance = new QRCodeStyling({
    ...qrOptions(config, 1080),
    type: extension === "svg" ? "svg" : "canvas",
  })
  await instance.download({ name, extension })
}
