# linq — Glossary

linq is a self-hosted link shortener: short Links on your own Domains, with Visit analytics. This file is the ubiquitous language only.

## Language

### Links

**Link**:
One short link: a Slug on a Domain that sends people to a Destination.
_Avoid_: Short URL, URL

**Slug**:
The path segment after the host. Random or custom, and immutable. Reserved for as long as its Link exists, Archived or not; only a Purge releases it.
_Avoid_: Alias, code, path

**Destination**:
The long URL a Link sends people to. A Link has one default Destination; a Rule supplies an alternate one.
_Avoid_: Target, long URL

**Rule**:
An ordered entry on a Link: an alternate Destination plus one or more Conditions, all of which must hold. The first matching Rule wins.
_Avoid_: Dynamic link

**Condition**:
One predicate inside a Rule: a platform (android, ios or desktop), or a query parameter that is present or has a given value.

**Preset Param**:
A query key and value a Link sets on its Destination, overriding any value already there or forwarded. Applies only when the Link forwards its query.

**Tag**:
A name attached to Links so they can be grouped and filtered. A Link may carry several.
_Avoid_: Label, category

**Listed**:
A Link its owner has opted in to publishing in its Domain's public catalogue. Unlisted Links still redirect; they are just never advertised.
_Avoid_: Public, published

**OG Preview**:
A Link's own Open Graph title, description and image, shown to chat and social previews instead of the Destination's.

**QR Code**:
A styled QR code for one Link's short URL. A Link may have several. It holds only styling, never the URL, so it always encodes the Link as it is now.

### Domains

**Domain**:
A host that Links live on.
_Avoid_: Host, hostname

**Fallback URL**:
Where a Domain sends Orphan Visits that no more specific redirect covers. Absent means not found.

**Root Redirect**:
Where a Domain sends a Visit to its bare root path.

**Invalid Slug Redirect**:
Where a Domain sends a Visit whose Slug is malformed, rather than merely unknown.

**App Host**:
The one host that serves the Client UI. Never a Domain: no Link lives on it.

### Visits

**Visit**:
One request to a Domain, flagged human or bot. Carries platform, device type, referer, user agent, forwarded query, UTM source, medium, campaign, content and term, and the Destination chosen. Never the client address.
_Avoid_: Click, hit

**Orphan Visit**:
A Visit on an active Domain that resolved to no active Link: an unknown Slug, an Archived Link, or the root path.

**Imported Visit**:
A Visit brought in from history recorded elsewhere. Unlike a Visit linq records itself, it may carry a location.

**Dropped Visit**:
A request that was served but never recorded as a Visit. Reports count only recorded Visits, so they can undercount.
_Avoid_: Lost click

### Access

**Key**:
An API key, and the only principal. Has a name and a Role, may expire, and is shown once. Links never record which Key created them.
_Avoid_: Token, user

**Role**:
`viewer` < `editor` < `admin`, carried by a Key. A viewer reads; an editor also creates and edits any Link; an admin also archives, restores and purges, and manages Domains and Keys.

**Archived**:
The reversible, soft-deleted status of a Link or Domain. An Archived Slug never redirects, and keeps its Visits and its reservation.
_Avoid_: Deleted

**Purge**:
The irreversible destruction of an Archived Link or Domain, by an admin. Destroys its Visits with it; purging a Link also releases its Slug.
_Avoid_: Delete, hard delete

### Client UI

**Server**:
One linq instance as the Client UI knows it: a name, an absolute URL and a Key, saved in one browser. The UI talks to whichever Server is selected, never assuming the one that served it.
_Avoid_: Instance, backend
