# linq

A self-hosted link shortener: short **Links** on your own **Domains**, the
**Visits** they receive, and the **Keys** that manage them.

## Language

### Links

**Link**:
A **Slug** on a **Domain**. A redirect Link sends people to a **Destination**;
a **Link Tree** serves a page instead.
_Avoid_: Short URL, URL, bitlink

**Slug**:
The path segment after the host that names a **Link** on its **Domain**:
random or custom, and immutable. It stays reserved while its **Link** exists,
archived or not, and is released only by a **Purge**.
_Avoid_: Alias, back-half, code

**Destination**:
The long URL a redirect **Link** sends people to. A **Link** has one default
Destination; a **Rule** supplies an alternate one.
_Avoid_: Target URL, long URL

**Preset Param**:
A query key and value a **Link** sets on its **Destination** at redirect
time, overriding both the Destination's own query and any forwarded query.
Applies only when the **Link** forwards its query.
_Avoid_: Default param, fixed param

**Rule**:
An ordered entry on a redirect **Link**: an alternate **Destination** plus one
or more **Conditions**, all of which must hold. The first matching Rule wins.
_Avoid_: Dynamic link, routing rule

**Condition**:
One predicate inside a **Rule**: `platform` (android, ios or desktop) or
`query_param` (a key with an optional value; no value means "present").
_Avoid_: Criterion, filter

**Link Tree**:
A **Link** that serves a hosted page (title, description, image and its own
appearance) listing **Items**, in the style of social-media profile link
pages. A view of that page is a **Visit** on the Link Tree.
_Avoid_: Link page, link-in-bio, bio page

**Item**:
An ordered entry on a **Link Tree**: a label and a target redirect **Link** on
the same **Domain**. One **Link** can be the target of Items on several Link
Trees, and a **Link Tree** is never an Item's target.
_Avoid_: Button, entry, tile

**OG Preview**:
A **Link**'s own Open Graph title, description and image, shown by chat and
social apps that unfurl it.
_Avoid_: Link preview, social card

**QR Code**:
A styled QR code for one **Link**'s short URL, carrying its own colours and
dot and corner pattern but never the URL itself. A **Link** may have several;
deleting one never affects the **Link**.
_Avoid_: QR, code

### Domains

**Domain**:
A host that **Links** live on, with an optional **Fallback URL**.
_Avoid_: Hostname, workspace

**Fallback URL**:
Where a **Domain** sends its **Orphan Visits**. Absent means not found.
_Avoid_: Default redirect, catch-all

### Visits

**Visit**:
One request to a **Domain**, flagged human or bot, recording the visitor's
platform, device type, referer, user agent, query and UTM fields, and the
**Destination** chosen. Never the client address.
_Avoid_: Click, hit, view

**Orphan Visit**:
A **Visit** on an active **Domain** that resolved to no active **Link**: an
unknown **Slug**, an **Archived** Link, or the root path.
_Avoid_: Orphan click, 404, miss

### Lifecycle

**Archived**:
The soft-deleted status of a **Link** or **Domain**. An Archived **Slug**
never redirects but keeps its **Visits** and its reservation; restoring or a
**Purge** are the only ways out.
_Avoid_: Deleted, trashed, disabled

**Purge**:
The irreversible destruction of an **Archived** **Link** or **Domain** by an
admin, taking its **Visits** with it. Purging a **Link** releases its
**Slug**.
_Avoid_: Delete, hard delete, empty trash

### Access

**Server**:
One linq instance as the Client UI knows it: a name, an absolute URL and a
**Key**, saved in one browser. The UI talks to whichever Server is selected.
_Avoid_: Instance, workspace, backend

**Key**:
An API key, and the only principal. It has a name and a **Role**, may expire,
and is shown once. **Links** are unowned: they carry no reference to the Key
that created them.
_Avoid_: User, account, token

**Role**:
What a **Key** may do: `viewer` reads; `editor` also creates and edits any
**Link**; `admin` also archives, restores and purges, and manages **Domains**
and **Keys**.
_Avoid_: Permission level, scope
