"use client"

import { type Actor, type ApiKeyCreated, can, ROLES, type Role, type User } from "@linq/shared"
import { Fragment, useState } from "react"
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
  useCreateUserMutation,
  useListKeysQuery,
  useListUsersQuery,
  useMintKeyMutation,
  useRevokeKeyMutation,
  useUpdateUserMutation,
} from "../../../lib/store/users"

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: role }))
const USERS_HEAD = ["Name", "Email", "Role", "Status", "", ""]
const KEYS_HEAD = ["Label", "Prefix", "Created", "Expires", ""]

/**
 * Users and their API keys. Admin only — and gated on the page, not just in the
 * nav, because the URL is typeable.
 *
 * A user never signs in, so everything on this page is about keys: minting one
 * is how a person gains access, revoking it is how they lose it, and disabling
 * the user kills every key at once.
 */
export default function UsersPage() {
  return <AppShell requires={can.manageUsers}>{(actor) => <Users actor={actor} />}</AppShell>
}

function Users({ actor }: { actor: Actor }) {
  const users = useListUsersQuery({ limit: 200 })
  const [updateUser] = useUpdateUserMutation()
  const [expanded, setExpanded] = useState<string | null>(null)
  const rows = users.data?.data ?? []

  /** Runs a write and surfaces the server's message on failure. */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
    } catch (err) {
      toast.error(errorMessage(err, "That did not work."))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="font-heading text-xl font-semibold">Users</h1>
        <div className="ml-auto">
          <AddUserDialog />
        </div>
      </div>

      <Card>
        <CardContent>
          <QueryState
            isLoading={users.isLoading}
            isFetching={users.isFetching}
            error={users.error}
            empty={rows.length === 0}
            skeleton={<TableSkeleton head={USERS_HEAD} />}
          />

          {rows.length > 0 ? (
            <DataTable head={USERS_HEAD}>
              {rows.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  actor={actor}
                  expanded={expanded === user.id}
                  onToggleExpand={() => setExpanded(expanded === user.id ? null : user.id)}
                  onSave={(body) => run(() => updateUser({ id: user.id, body }).unwrap())}
                />
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

/** One row, with name and email editable in place. */
function UserRow({
  user,
  actor,
  expanded,
  onToggleExpand,
  onSave,
}: {
  user: User
  actor: Actor
  expanded: boolean
  onToggleExpand: () => void
  onSave: (body: {
    name?: string
    email?: string | null
    role?: Role
    status?: User["status"]
  }) => void
}) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email ?? "")
  const changed = name.trim() !== user.name || email.trim() !== (user.email ?? "")

  function save() {
    onSave({ name: name.trim(), email: email.trim() || null })
  }

  return (
    <Fragment>
      <TableRow className={user.status === "disabled" ? "opacity-60" : undefined}>
        <TableCell className="max-w-[14rem]">
          <div className="flex items-center gap-2">
            <Input
              className="min-w-0"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {user.id === actor.userId ? (
              <Badge variant="secondary" className="shrink-0">
                You
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="max-w-xs">
          <div className="flex items-center gap-2">
            <Input
              type="email"
              value={email}
              placeholder="person@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
            {changed ? (
              <Button type="button" onClick={save}>
                Save
              </Button>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          <Picker
            className="w-32"
            value={user.role}
            // Nobody changes their own role: the server refuses it too.
            disabled={!can.changeRoleOf(actor, user.id)}
            onChange={(role) => onSave({ role: role as Role })}
            options={ROLE_OPTIONS}
          />
        </TableCell>
        <TableCell>
          {user.status === "disabled" ? <Badge variant="outline">Disabled</Badge> : null}
        </TableCell>
        <TableCell>
          <Button type="button" variant="outline" onClick={onToggleExpand}>
            {expanded ? "Hide keys" : "Keys"}
          </Button>
        </TableCell>
        <TableCell>
          {/* Disabling yourself would lock you out with no way back in, so the
              action isn't just refused, it isn't offered. */}
          {user.id === actor.userId ? null : user.status === "active" ? (
            <ConfirmButton
              title={`Disable ${user.name}?`}
              description="Every key this user holds stops working immediately. Re-enabling restores them; nothing is deleted."
              confirmLabel="Disable"
              onConfirm={() => onSave({ status: "disabled" })}
            >
              Disable
            </ConfirmButton>
          ) : (
            <Button type="button" variant="outline" onClick={() => onSave({ status: "active" })}>
              Enable
            </Button>
          )}
        </TableCell>
      </TableRow>

      {expanded ? (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/50 whitespace-normal">
            <KeysPanel userId={user.id} />
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  )
}

/**
 * The keys of one user.
 *
 * A freshly minted secret is held in component state and shown once, because
 * the server only ever returns it in that one response. Navigating away loses
 * it for good, which the copy prompt says out loud.
 */
function KeysPanel({ userId }: { userId: string }) {
  const keys = useListKeysQuery(userId)
  const [mintKey] = useMintKeyMutation()
  const [revokeKey] = useRevokeKeyMutation()
  const [label, setLabel] = useState("")
  const [minted, setMinted] = useState<ApiKeyCreated | null>(null)

  async function mint() {
    try {
      setMinted(await mintKey({ userId, label: label.trim() }).unwrap())
      setLabel("")
    } catch (err) {
      toast.error(errorMessage(err, "Could not mint a key."))
    }
  }

  async function revoke(keyId: string) {
    try {
      await revokeKey({ userId, keyId }).unwrap()
    } catch (err) {
      toast.error(errorMessage(err, "Could not revoke that key."))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          value={label}
          placeholder="Label, e.g. ci or laptop"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="button" disabled={!label.trim()} onClick={mint}>
          Mint key
        </Button>
      </div>

      {minted ? (
        <div className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">Copy this key now. It is never shown again.</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="font-mono text-xs break-all">{minted.secret}</code>
            <CopyButton value={minted.secret} label="Copy" />
          </div>
        </div>
      ) : null}

      <QueryState
        isLoading={keys.isLoading}
        isFetching={keys.isFetching}
        error={keys.error}
        empty={(keys.data ?? []).length === 0}
        emptyMessage="No keys. This user cannot reach the API."
        skeleton={<TableSkeleton head={KEYS_HEAD} />}
      />

      {(keys.data ?? []).length > 0 ? (
        <DataTable head={KEYS_HEAD}>
          {(keys.data ?? []).map((key) => (
            <TableRow key={key.id}>
              <TableCell className="max-w-[14rem] truncate">{key.label}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {key.prefix}…
              </TableCell>
              <TableCell>
                <When iso={key.createdAt} />
              </TableCell>
              <TableCell>{key.expiresAt ? <When iso={key.expiresAt} /> : "never"}</TableCell>
              <TableCell>
                <ConfirmButton
                  title={`Revoke the key "${key.label}"?`}
                  description="Revoking is a real delete, not an archive. Anything using this key stops working at once and it cannot be restored."
                  confirmLabel="Revoke"
                  size="sm"
                  onConfirm={() => revoke(key.id)}
                >
                  Revoke
                </ConfirmButton>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      ) : null}
    </div>
  )
}

/**
 * Add-a-user, as a dialog: fill in name/email/role, create the user, and mint
 * its first key in the same breath so the dialog can show the one chance to
 * copy the secret, exactly like minting one later from the keys panel does.
 */
function AddUserDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("viewer")
  const [saving, setSaving] = useState(false)
  const [minted, setMinted] = useState<ApiKeyCreated | null>(null)
  const [createUser] = useCreateUserMutation()
  const [mintKey] = useMintKeyMutation()

  function openChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setName("")
      setEmail("")
      setRole("viewer")
      setMinted(null)
    }
  }

  async function create() {
    setSaving(true)
    try {
      const user = await createUser({
        name: name.trim(),
        email: email.trim() || null,
        role,
      }).unwrap()
      setMinted(await mintKey({ userId: user.id, label: "initial" }).unwrap())
    } catch (err) {
      toast.error(errorMessage(err, "That did not work."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger asChild>
        <Button type="button">Add user</Button>
      </DialogTrigger>
      <DialogContent>
        {minted ? (
          <>
            <DialogHeader>
              <DialogTitle>{name} is in</DialogTitle>
              <DialogDescription>Copy this key now. It is never shown again.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <code className="min-w-0 flex-1 font-mono text-xs break-all">{minted.secret}</code>
              <CopyButton value={minted.secret} label="Copy" />
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => openChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a user</DialogTitle>
              <DialogDescription>
                A key is minted right away, so they can reach the API immediately.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Email" hint="Optional, but unique when set.">
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="person@example.com"
                />
              </Field>
              <Field label="Role">
                <Picker
                  value={role}
                  onChange={(value) => setRole(value as Role)}
                  options={ROLE_OPTIONS}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => openChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!name.trim() || saving} onClick={create}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
