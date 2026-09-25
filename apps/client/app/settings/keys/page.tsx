"use client"

import {
  type Actor,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeySummary,
  can,
  type KeyPreset,
  PRESETS,
} from "@linq/shared"
import { KeyRound, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, CopyButton, Field, Picker, When } from "@/components/common"
import {
  Collection,
  PageHeader,
  RowCard,
  RowCardTile,
  SettingsNav,
  Tag,
} from "@/components/patterns"
import { Button } from "@/components/ui/button"
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
import { useRun } from "../../../lib/hooks"
import {
  useListKeysQuery,
  useMintKeyMutation,
  useRevokeKeyMutation,
  useUpdateKeyMutation,
} from "../../../lib/store/keys"

const PRESET_OPTIONS = PRESETS.map((preset) => ({ value: preset, label: preset }))

/**
 * Keys are the principals, so this page is the whole of access control: minting
 * one is how a person gains access, revoking it is how they lose it, and there
 * is nothing else to disable. See docs/adr/0011.
 */
export default function KeysPage() {
  return (
    <AppShell>
      {(actor) => (
        <div className="no-scrollbar flex h-full min-h-0 flex-col overflow-y-auto px-7 py-6">
          <SettingsNav actor={actor}>
            <Keys actor={actor} />
          </SettingsNav>
        </div>
      )}
    </AppShell>
  )
}

function Keys({ actor }: { actor: Actor }) {
  const keys = useListKeysQuery({ limit: 200 })
  const rows = keys.data?.data ?? []

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="API keys"
        description="Review the scoped keys that can access this workspace."
        actions={can.manageKeys(actor) ? <MintKeyDialog /> : undefined}
      />

      <Collection
        query={keys}
        rows={rows}
        variant="list"
        emptyMessage="No keys. Nothing can reach the API."
      >
        {(key) => <KeyRow key={key.id} apiKey={key} actor={actor} />}
      </Collection>
    </div>
  )
}

function KeyRow({ apiKey, actor }: { apiKey: ApiKey | ApiKeySummary; actor: Actor }) {
  const [updateKey] = useUpdateKeyMutation()
  const [revokeKey] = useRevokeKeyMutation()
  const { run, saving } = useRun()

  const isMine = apiKey.id === actor.keyId
  const canManage = can.manageKeys(actor)
  const hasDetails = (key: ApiKey | ApiKeySummary): key is ApiKey => "prefix" in key

  const save = (body: Record<string, unknown>) =>
    run(() => updateKey({ id: apiKey.id, body }).unwrap(), {
      success: "Key updated.",
      fallback: "Could not update that key.",
    })

  return (
    <RowCard
      tile={
        <RowCardTile>
          <KeyRound className="size-4" />
        </RowCardTile>
      }
      actions={
        canManage ? (
          <>
            {/* Nobody changes their own role — the one-way door out of admin — so a
              disabled control there would just be a Picker that never does anything.
              Shown as a plain tag next to the name instead (below), same as any
              other key's role once it's not editable. */}
            {isMine ? null : (
              <Picker
                className="h-8 w-28"
                value={apiKey.preset ?? "viewer"}
                disabled={saving}
                onChange={(preset) => save({ preset: preset as KeyPreset })}
                options={PRESET_OPTIONS}
              />
            )}
            {/* Revoking the key in your own hand would lock you out with only the
              CLI left as a way back, so it is not offered rather than refused. */}
            {isMine ? null : (
              <ConfirmButton
                className="size-10"
                ariaLabel="Revoke key"
                title={`Revoke ${apiKey.name}?`}
                description="This key stops working immediately. Revoking is a real delete, not an archive."
                confirmLabel="Revoke"
                onConfirm={() =>
                  run(() => revokeKey(apiKey.id).unwrap(), {
                    success: "Key revoked.",
                    fallback: "Could not revoke that key.",
                  })
                }
              >
                <Trash2 />
              </ConfirmButton>
            )}
          </>
        ) : null
      }
    >
      <span className="flex items-center gap-2">
        <span className="truncate font-medium">{apiKey.name}</span>
        {isMine ? <Tag>{apiKey.preset ?? "custom claims"}</Tag> : null}
        {isMine ? <Tag>This key</Tag> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {hasDetails(apiKey) ? (
          <>
            {apiKey.prefix} · Created <When iso={apiKey.created_at} relative />
            {apiKey.expires_at ? (
              <>
                {" "}
                · Expires <When iso={apiKey.expires_at} relative />
              </>
            ) : null}
          </>
        ) : (
          (apiKey.preset ?? "Custom claims")
        )}
      </span>
    </RowCard>
  )
}

function MintKeyDialog() {
  const [mintKey] = useMintKeyMutation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [preset, setPreset] = useState<KeyPreset>("viewer")
  const [minted, setMinted] = useState<ApiKeyCreated | null>(null)
  const { run, saving } = useRun()

  const close = () => {
    setOpen(false)
    setName("")
    setPreset("viewer")
    setMinted(null)
  }

  const mint = () =>
    run(() => mintKey({ name: name.trim(), preset }).unwrap(), {
      fallback: "Could not mint that key.",
      onSuccess: setMinted,
    })

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Create API key
        </Button>
      </DialogTrigger>
      <DialogContent>
        {minted ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                Copy this key now — you won't be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <Field label="Secret key">
              <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs">{minted.secret}</code>
                <CopyButton value={minted.secret} />
              </div>
            </Field>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <Field label="Name" hint="Who or what this key is for.">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Claim preset" hint="The initial claim set for this key.">
                <Picker
                  value={preset}
                  onChange={(value) => setPreset(value as KeyPreset)}
                  options={PRESET_OPTIONS}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={saving || !name.trim()} onClick={mint}>
                Create key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
