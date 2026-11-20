import { EMPTY_METADATA, type Metadata, type MetadataFetcher } from "@linq/shared"

/** What runs when LINQ_FETCH_LINK_METADATA=false, and what the test harness
 *  defaults to — no test should make a real network call by accident. */
export class NoopLinkMetadataAdapter implements MetadataFetcher {
  async fetch(_destination: string): Promise<Metadata> {
    return EMPTY_METADATA
  }
}
