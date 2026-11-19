import {
  type LinkPatch,
  type LinkRow,
  type LinkUpdate,
  LinkUtil,
  type Metadata,
} from "@linq/shared"

/**
 * Maps a patch to the `links` columns it changes. Spelled out rather than a
 * blanket `...patch` spread: `expires_at` arrives as an ISO string and the
 * column takes a Date. `fetched` fills only the fields the patch leaves alone.
 *
 * @param existing - The row being patched.
 * @param patch - The validated patch body.
 * @param fetched - The new destination's metadata, or null when it is unchanged.
 * @returns The update set, `updated_at` included.
 */
export class LinkPatchToLinkUpdateConverter {
  convertFrom(existing: LinkRow, patch: LinkPatch, fetched: Metadata | null): LinkUpdate {
    return {
      ...(patch.destination !== undefined ? { destination: patch.destination } : {}),
      ...(patch.name !== undefined
        ? { name: patch.name }
        : fetched
          ? { name: fetched.name ?? existing.name ?? LinkUtil.destinationTitle(patch.destination!) }
          : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : fetched
          ? { description: fetched.description ?? existing.description }
          : {}),
      ...(fetched ? { icon_url: fetched.icon_url ?? existing.icon_url } : {}),
      ...(patch.forward_query !== undefined ? { forward_query: patch.forward_query } : {}),
      ...(patch.preset_params !== undefined ? { preset_params: patch.preset_params } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.expires_at !== undefined
        ? { expires_at: patch.expires_at ? new Date(patch.expires_at) : null }
        : {}),
      ...(patch.listed !== undefined ? { listed: patch.listed } : {}),
      updated_at: new Date(),
    }
  }
}
