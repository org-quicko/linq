"use client"

import { can } from "@linq/shared"
import { useRouter } from "next/navigation"
import { type SyntheticEvent, useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { Field, Picker, QueryState } from "@/components/common"
import { TagPicker } from "@/components/tag-picker"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage, qs } from "../../../lib/api"
import { useListDomainsQuery } from "../../../lib/store/domains"
import { useCreateLinkMutation } from "../../../lib/store/links"

/**
 * Creates one link.
 *
 * Slug is optional: left blank the server generates one, which is the common
 * case. Everything else here maps straight onto the create payload, so the
 * server stays the only place that decides what is valid.
 */
export default function NewLinkPage() {
  // A viewer reaching this URL directly gets the refusal, not a live form.
  return <AppShell requires={can.createLink}>{() => <NewLinkForm />}</AppShell>
}

function NewLinkForm() {
  const router = useRouter()
  const domains = useListDomainsQuery({ limit: 200 })
  const [createLink] = useCreateLinkMutation()
  const active = (domains.data?.data ?? []).filter((domain) => domain.status === "active")

  const [domainId, setDomainId] = useState("")
  const [slug, setSlug] = useState("")
  const [destination, setDestination] = useState("")
  const [name, setName] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [forwardQuery, setForwardQuery] = useState(true)
  const [saving, setSaving] = useState(false)

  const chosenDomain = domainId || active[0]?.id || ""

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      const created = await createLink({
        domainId: chosenDomain,
        slug: slug.trim() || undefined,
        destination: destination.trim(),
        name: name.trim() || undefined,
        tags,
        forwardQuery,
      }).unwrap()
      router.push(`/links/detail/${qs({ id: created.id })}`)
    } catch (err) {
      toast.error(errorMessage(err, "Could not create the link."))
      setSaving(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="font-heading text-xl font-semibold">New link</h1>

      <Card>
        <CardContent>
          <QueryState
            isLoading={domains.isLoading}
            isFetching={domains.isFetching}
            error={domains.error}
            empty={!domains.isLoading && active.length === 0}
            emptyMessage="No active domain to create a link on. An admin must add one first."
          />

          {active.length > 0 ? (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field label="Domain">
                <Picker
                  value={chosenDomain}
                  onChange={setDomainId}
                  options={active.map((domain) => ({ value: domain.id, label: domain.host }))}
                />
              </Field>

              <Field label="Destination" hint="An absolute http(s) URL.">
                <Input
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="https://example.com/landing"
                  required
                />
              </Field>

              <Field
                label="Slug"
                hint="Leave blank for a generated one. A slug can never be changed or reused."
              >
                <Input
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="spring-sale"
                  spellCheck={false}
                />
              </Field>

              <Field label="Name" hint="Optional, for your own reference.">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>

              <Field label="Tags" hint="Pick one in use, or add a new one.">
                <TagPicker value={tags} onChange={setTags} creatable placeholder="No tags" />
              </Field>

              <Label className="font-normal">
                <Checkbox
                  checked={forwardQuery}
                  onCheckedChange={(checked) => setForwardQuery(checked === true)}
                />
                Forward incoming query parameters to the destination
              </Label>

              <div className="flex gap-2">
                <Button type="submit" disabled={saving || !destination.trim()}>
                  {saving ? "Creating…" : "Create link"}
                </Button>
                {/* Explicitly type="button": inside a form, an untyped button submits. */}
                <Button type="button" variant="outline" onClick={() => router.back()}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
