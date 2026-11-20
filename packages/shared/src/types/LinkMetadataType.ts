export type Metadata = { name: string | null; description: string | null; icon_url: string | null }

/** The link-metadata port: what `LinkService` asks for a destination's title, description and icon. */
export interface MetadataFetcher {
  fetch(destination: string): Promise<Metadata>
}
