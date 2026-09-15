# linq — Glossary

The ubiquitous language of linq. Terms only; no implementation details.

- **Linq**: one short link. A Slug on a Domain, owned by a User. Kind `redirect` (has a Destination, may have Rules) or `tree` (serves a Tree page).
- **Slug**: the path segment after the host. Random or custom. Immutable. Reserved for as long as its Linq exists, archived or not; released only by a Purge.
- **Domain**: a host that Linqs live on. Has an optional Fallback URL.
- **Destination**: the long URL a redirect Linq sends people to. A Linq has one default Destination; a Rule supplies an alternate one.
- **Rule**: an ordered entry on a Linq. An alternate Destination plus one or more Conditions, all of which must hold. First matching Rule wins. Also called a "dynamic link".
- **Condition**: one predicate inside a Rule. `platform` (android | ios | desktop), `query_param` (key with optional value; no value means "present"), `country` (ISO-3166 alpha-2).
- **Click**: one request to a Domain. Flagged human or bot. Carries platform, country, region, referer, user agent, forwarded query, and the Destination chosen.
- **Orphan Click**: a Click on an active Domain that resolved to no active Linq: unknown Slug, archived Linq, or the root path.
- **Fallback URL**: where a Domain sends Orphan Clicks. Absent means 404.
- **Tree**: a Linq of kind `tree`. Serves a hosted page (title, description, image) listing Items, in the style of social-media profile link pages.
- **Item**: an ordered entry on a Tree: a label and a target Linq on the same Domain.
- **OG Preview**: per-Linq Open Graph title, description and image, served as HTML to bots so chat and social previews show them.
- **User**: an owner and principal. Has a Role and a status (active | disabled). Never logs in; acts only through Keys.
- **Key**: an API key belonging to a User. Shown once, stored hashed. May expire.
- **Role**: `viewer` < `author` < `editor` < `admin`. Viewer reads; author also creates and manages own Linqs; editor also manages any Linq; admin also manages Domains, Users and Keys.
- **Archived**: the soft-deleted status of a Linq or Domain. An archived Slug never redirects, and keeps its Clicks and its reservation. Reversible; the only route out of it other than restoring is a Purge.
- **Purge**: the irreversible destruction of an archived Linq or Domain, by an admin. Distinct from archiving, which is what `DELETE` does. Purging a Linq releases its Slug and leaves its Clicks as Orphan Clicks; purging a Domain destroys its Clicks with it.
