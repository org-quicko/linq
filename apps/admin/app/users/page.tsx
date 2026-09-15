"use client"

import {
  type Actor,
  type ApiKey,
  type ApiKeyCreated,
  can,
  type Page,
  ROLES,
  type Role,
  type User,
} from "@linq/shared"
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
  When,
} from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { del, patch, post } from "../../lib/api"
import { useApi } from "../../lib/use-api"

const ROLE_OPTIONS = ROLES.map((role) => ({ value: role, label: role }))

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
  const users = useApi<Page<User>>("/v1/users?limit=200")
  const [expanded, setExpanded] = useState<string | null>(null)
  const rows = users.data?.data ?? []

  /** Runs a write, surfaces the server's message, and refreshes the list. */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      users.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-xl font-semibold">Users</h1>

      <NewUserCard onCreate={(body) => run(() => post("/v1/users", body))} />

      <Card>
        <CardContent>
          <QueryState loading={users.loading} error={users.error} empty={rows.length === 0} />

          {rows.length > 0 ? (
            <DataTable head={["Name", "Email", "Role", "Status", "", ""]}>
              {rows.map((user) => (
                <Fragment key={user.id}>
                  <TableRow className={user.status === "disabled" ? "opacity-60" : undefined}>
                    <TableCell className="max-w-[14rem] truncate font-medium">
                      {user.name}
                      {user.id === actor.userId ? (
                        <span className="ml-2 text-xs text-muted-foreground">you</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {user.email ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Picker
                        className="w-32"
                        value={user.role}
                        // Nobody changes their own role: the server refuses it too.
                        disabled={!can.changeRoleOf(actor, user.id)}
                        onChange={(role) => run(() => patch(`/v1/users/${user.id}`, { role }))}
                        options={ROLE_OPTIONS}
                      />
                    </TableCell>
                    <TableCell>
                      {user.status === "disabled" ? (
                        <Badge variant="outline">Disabled</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setExpanded(expanded === user.id ? null : user.id)}
                      >
                        {expanded === user.id ? "Hide keys" : "Keys"}
                      </Button>
                    </TableCell>
                    <TableCell>
                      {user.status === "active" ? (
                        <ConfirmButton
                          title={`Disable ${user.name}?`}
                          description="Every key this user holds stops working immediately. Re-enabling restores them; nothing is deleted."
                          confirmLabel="Disable"
                          // Disabling yourself would lock you out with no way back in.
                          disabled={!can.disableUser(actor, user.id)}
                          onConfirm={() =>
                            run(() => patch(`/v1/users/${user.id}`, { status: "disabled" }))
                          }
                        >
                          Disable
                        </ConfirmButton>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            run(() => patch(`/v1/users/${user.id}`, { status: "active" }))
                          }
                        >
                          Enable
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>

                  {expanded === user.id ? (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/50 whitespace-normal">
                        <KeysPanel userId={user.id} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
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
  const keys = useApi<ApiKey[]>(`/v1/users/${userId}/keys`)
  const [label, setLabel] = useState("")
  const [minted, setMinted] = useState<ApiKeyCreated | null>(null)

  async function mint() {
    try {
      setMinted(await post<ApiKeyCreated>(`/v1/users/${userId}/keys`, { label: label.trim() }))
      setLabel("")
      keys.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mint a key.")
    }
  }

  async function revoke(keyId: string) {
    try {
      await del(`/v1/keys/${keyId}`)
      keys.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke that key.")
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
        loading={keys.loading}
        error={keys.error}
        empty={(keys.data ?? []).length === 0}
        emptyMessage="No keys. This user cannot reach the API."
      />

      {(keys.data ?? []).length > 0 ? (
        <DataTable head={["Label", "Prefix", "Created", "Expires", ""]}>
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

/** The add-a-user form. Creating the user does not create a key for them. */
function NewUserCard({
  onCreate,
}: {
  onCreate: (body: { name: string; email: string | null; role: Role }) => void
}) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("viewer")

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Add a user</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-44 flex-1">
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
          </div>
          <div className="min-w-44 flex-1">
            <Field label="Email" hint="Optional, but unique when set.">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@example.com"
              />
            </Field>
          </div>
          <div className="w-36">
            <Field label="Role">
              <Picker
                value={role}
                onChange={(value) => setRole(value as Role)}
                options={ROLE_OPTIONS}
              />
            </Field>
          </div>
          <Button
            type="button"
            disabled={!name.trim()}
            onClick={() => {
              onCreate({ name: name.trim(), email: email.trim() || null, role })
              setName("")
              setEmail("")
              setRole("viewer")
            }}
          >
            Add user
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          A new user has no key yet, so it cannot reach the API until you mint one.
        </p>
      </CardContent>
    </Card>
  )
}
