"use client"

import { type Actor, type ApiKey, type ApiKeyCreated, can, ROLES, type Role } from "@linq/shared"
import { useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import {
  ConfirmButton,
  CopyButton,
  DataTable,
  Field,
  Picker,
  QueryState,
  TableSkeleton,
  When,
} from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { errorMessage } from "../../../lib/api"
import {
  useListKeysQuery,
  useMintKeyMutation,
  useReassignKeyLinksMutation,
  useRevokeKeyMutation,
  useUpdateKeyMutation,
} from "../../../lib/store/keys"

/** Radix refuses an item whose value is the empty string; this sentinel means "unassigned". */
const UNASSIGNED = "__unassigned__"

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: role }))
const HEAD = ["Name", "Role", "Prefix", "Created", "Expires", "", ""]

/**
 * Keys are the principals, so this page is the whole of access control: minting
 * one is how a person gains access, revoking it is how they lose it, and there
 * is nothing else to disable. See docs/adr/0011.
 */
export default function KeysPage() {
  return <AppShell requires={can.manageKeys}>{(actor) => <Keys actor={actor} />}</AppShell>
}

function Keys({ actor }: { actor: Actor }) {
  const keys = useListKeysQuery({ limit: 200 })
  const rows = keys.data?.data ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-lg">Keys</h1>
        <MintKeyDialog />
      </div>

      <Card>
        <CardContent>
          <QueryState
            isLoading={keys.isLoading}
            isFetching={keys.isFetching}
            error={keys.error}
            empty={rows.length === 0}
            emptyMessage="No keys. Nothing can reach the API."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {rows.length > 0 ? (
            <DataTable head={HEAD}>
              {rows.map((key) => (
                <KeyRow key={key.id} apiKey={key as ApiKey} actor={actor} allKeys={rows as ApiKey[]} />
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function KeyRow({
  apiKey,
  actor,
  allKeys,
}: {
  apiKey: ApiKey
  actor: Actor
  allKeys: ApiKey[]
}) {
  const [updateKey] = useUpdateKeyMutation()
  const [revokeKey] = useRevokeKeyMutation()
  const [name, setName] = useState(apiKey.name)
  const [saving, setSaving] = useState(false)

  const isMine = apiKey.id === actor.keyId
  const changed = name.trim() !== apiKey.name && name.trim().length > 0

  const save = async (body: Record<string, unknown>) => {
    setSaving(true)
    try {
      await updateKey({ id: apiKey.id, body }).unwrap()
      toast.success("Key updated.")
    } catch (err) {
      toast.error(errorMessage(err, "Could not update that key."))
    }
    setSaving(false)
  }

  return (
    <TableRow>
      <TableCell className="flex items-center gap-2">
        <Input
          className="w-44"
          value={name}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
        {isMine ? <Badge variant="secondary">This key</Badge> : null}
      </TableCell>
      <TableCell>
        {/* An admin demoting the key it is calling with could not undo it. */}
        <Picker
          className="w-32"
          value={apiKey.role}
          disabled={!can.changeRoleOf(actor, apiKey.id) || saving}
          onChange={(role) => save({ role: role as Role })}
          options={ROLE_OPTIONS}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">{apiKey.prefix}</TableCell>
      <TableCell className="text-muted-foreground">
        <When iso={apiKey.createdAt} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {apiKey.expiresAt ? <When iso={apiKey.expiresAt} /> : "never"}
      </TableCell>
      <TableCell>
        {changed ? (
          <Button size="sm" disabled={saving} onClick={() => save({ name: name.trim() })}>
            Save
          </Button>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <ReassignLinksDialog apiKey={apiKey} allKeys={allKeys} />
          {/* Revoking the key in your own hand would lock you out with only the
              CLI left as a way back, so it is not offered rather than refused. */}
          {isMine ? null : (
            <ConfirmButton
              variant="destructive"
              size="sm"
              title={`Revoke ${apiKey.name}?`}
              description="This key stops working immediately, and any link it owns becomes unowned. Revoking is a real delete, not an archive."
              onConfirm={async () => {
                try {
                  await revokeKey(apiKey.id).unwrap()
                  toast.success("Key revoked.")
                } catch (err) {
                  toast.error(errorMessage(err, "Could not revoke that key."))
                }
              }}
            >
              Revoke
            </ConfirmButton>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/**
 * The remedy for a demotion the server just refused (409, naming a link
 * count): move every link this key owns to another key, or leave them
 * unassigned, in one call. Offered on every row, not only after a refused
 * demotion, since reassigning ahead of time is the same operation.
 */
function ReassignLinksDialog({ apiKey, allKeys }: { apiKey: ApiKey; allKeys: ApiKey[] }) {
  const [reassign] = useReassignKeyLinksMutation()
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState(UNASSIGNED)
  const [saving, setSaving] = useState(false)

  const options = [
    { value: UNASSIGNED, label: "Leave unassigned" },
    ...allKeys
      // The server refuses a viewer as a target, same rule as a single
      // link's transfer, so never offer one here either.
      .filter((key) => key.id !== apiKey.id && can.ownLink(key))
      .map((key) => ({ value: key.id, label: key.name })),
  ]

  const run = async () => {
    setSaving(true)
    try {
      const result = await reassign({
        id: apiKey.id,
        to: to === UNASSIGNED ? null : to,
      }).unwrap()
      toast.success(`Reassigned ${result.moved} link${result.moved === 1 ? "" : "s"}.`)
      setOpen(false)
      setTo(UNASSIGNED)
    } catch (err) {
      toast.error(errorMessage(err, "Could not reassign those links."))
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Reassign links
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reassign {apiKey.name}'s links</DialogTitle>
          <DialogDescription>
            Moves every link this key owns to another key, or leaves them unassigned. Revoking the
            key does this automatically; use this to do it ahead of time, such as before demoting
            the key to viewer.
          </DialogDescription>
        </DialogHeader>
        <Picker value={to} onChange={setTo} options={options} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={run}>
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MintKeyDialog() {
  const [mintKey] = useMintKeyMutation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("viewer")
  const [minted, setMinted] = useState<ApiKeyCreated | null>(null)
  const [saving, setSaving] = useState(false)

  const close = () => {
    setOpen(false)
    setName("")
    setRole("viewer")
    setMinted(null)
  }

  const mint = async () => {
    setSaving(true)
    try {
      setMinted(await mintKey({ name: name.trim(), role }).unwrap())
    } catch (err) {
      toast.error(errorMessage(err, "Could not mint that key."))
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm">Mint key</Button>
      </DialogTrigger>
      <DialogContent>
        {minted ? (
          <>
            <DialogHeader>
              <DialogTitle>{minted.name} is in</DialogTitle>
              <DialogDescription>Copy this key now. It is never shown again.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-muted p-2 font-mono text-xs">
                {minted.secret}
              </code>
              <CopyButton value={minted.secret} />
            </div>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Mint a key</DialogTitle>
              <DialogDescription>
                The secret is shown once and stored only as a hash.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field label="Name" hint="Who or what this key is for.">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Role" hint="What it may do.">
                <Picker
                  value={role}
                  onChange={(value) => setRole(value as Role)}
                  options={ROLE_OPTIONS}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={saving || !name.trim()} onClick={mint}>
                Mint
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
