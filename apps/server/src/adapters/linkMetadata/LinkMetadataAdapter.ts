import type { MetadataFetcher } from "@linq/shared"
import type { Config } from "../../config.ts"
import { HtmlLinkMetadataAdapter } from "./HtmlLinkMetadataAdapter.ts"
import { NoopLinkMetadataAdapter } from "./NoopLinkMetadataAdapter.ts"

/** Opening link-metadata fetching. */
export class LinkMetadataAdapter {
  /**
   * Opens the HTML adapter, or the no-op when LINQ_FETCH_LINK_METADATA=false.
   *
   * @param config - LINQ_FETCH_LINK_METADATA.
   * @returns The adapter. Not guarded: `createApp` guards it at the seam.
   */
  static start(config: Pick<Config, "LINQ_FETCH_LINK_METADATA">): MetadataFetcher {
    return config.LINQ_FETCH_LINK_METADATA === "false"
      ? new NoopLinkMetadataAdapter()
      : new HtmlLinkMetadataAdapter()
  }
}
