import { EMPTY_METADATA, type Metadata, type MetadataFetcher } from "@linq/shared"
import { Logger } from "../../libs/index.ts"

/** Makes a metadata fetch unable to fail its caller: any error reads as "no metadata". */
export class GuardedLinkMetadata implements MetadataFetcher {
  /**
   * @param fetcher - The adapter to guard.
   */
  constructor(private readonly fetcher: MetadataFetcher) {}

  async fetch(destination: string): Promise<Metadata> {
    try {
      return await this.fetcher.fetch(destination)
    } catch (err) {
      Logger.forRequest().debug({ err, destination }, "link metadata fetch failed")
      return EMPTY_METADATA
    }
  }
}
