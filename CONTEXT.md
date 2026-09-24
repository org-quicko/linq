# linq — Glossary

The ubiquitous language of linq. Terms only; no implementation details.

- **Link**: one short link. A Slug on a Domain, owned by a Key. Kind `redirect` (has a Destination, may have Rules) or `tree` (serves a Tree page).
- **Slug**: the path segment after the host. Random or custom. Immutable. Reserved for as long as its Link exists, archived or not; released only by a Purge.
- **Domain**: a host that Links live on. Has an optional Fallback URL.
- **Destination**: the long URL a redirect Link sends people to. A Link has one default Destination; a Rule supplies an alternate one.
- **Preset Param**: a key and value set on the Destination at redirect time, overriding the Destination's own query and any forwarded query on collision. Applied only when the Link forwards its query.
- **Rule**: an ordered entry on a Link. An alternate Destination plus one or more Conditions, all of which must hold. First matching Rule wins. Also called a "dynamic link".
- **Condition**: one predicate inside a Rule. `platform` (android | ios | desktop) or `query_param` (key with optional value; no value means "present").
- **Visit**: one request to a Domain. Flagged human or bot. Carries platform, referer, user agent, forwarded query, and the Destination chosen. Never the client address.
- **Orphan Visit**: a Visit on an active Domain that resolved to no active Link: unknown Slug, archived Link, or the root path.
- **Fallback URL**: where a Domain sends Orphan Visits. Absent means 404.
- **Tree**: a Link of kind `tree`. Serves a hosted page (title, description, image) listing Items, in the style of social-media profile link pages.
- **Item**: an ordered entry on a Tree: a label and a target Link on the same Domain.
- **OG Preview**: per-Link Open Graph title, description and image, served as HTML to bots so chat and social previews show them.
- **Server**: one linq instance, as the Client UI knows it: a name, an absolute URL and a Key, saved in one browser. The UI holds a list and talks to whichever is selected; it never assumes the instance that served it. See docs/adr/0006.
- **Key**: an API key, and the only principal. Has a name and a Role, and may expire. Shown once, stored hashed. Revoking one is a real delete. Links carry no reference to the Key that created them — see docs/adr/0016.
- **Role**: `viewer` < `editor` < `admin`. Carried by a Key. Viewer reads; editor also creates and edits any Link; admin also archives, restores and purges Links, and manages Domains and Keys.
- **Archived**: the soft-deleted status of a Link or Domain. An archived Slug never redirects, and keeps its Visits and its reservation. Reversible; the only route out of it other than restoring is a Purge.
- **Purge**: the irreversible destruction of an archived Link or Domain, by an admin. Distinct from archiving, which is what `DELETE` does. Purging a Link releases its Slug and destroys its Visits with it; purging a Domain destroys its Visits the same way.
- **QR Code**: a styled QR code for a Link's short URL. Always belongs to exactly one Link; a Link may have several. Carries its own colours and a dot/corner pattern, but never the encoded URL itself — that is always the Link's current short URL, resolved at render time. Deleted, not archived; deleting one removes only the saved styling, never the Link.
