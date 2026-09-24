"use client"

import { Eye, EyeOff, X } from "lucide-react"
import { type ReactNode, type SyntheticEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useRun } from "../lib/hooks"
import { normalizeUrl, probeServer } from "../lib/servers"

/**
 * The Add server dialog, opened on top of the Servers page.
 *
 * The details are verified before they are handed back: a record that cannot
 * answer is how a UI ends up unable to explain why nothing loads, and the
 * check costs one round trip at the only moment the user is looking.
 */
export function AddServerDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (values: { name: string; apiUrl: string; apiKey: string }) => void
}) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, saving: checking } = useRun()

  // Closing clears the form, so the next open starts blank.
  function reset() {
    setName("")
    setUrl("")
    setApiKey("")
    setRevealed(false)
    setError(null)
  }

  function setOpen(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  const trimmedName = name.trim()
  const trimmedKey = apiKey.trim()
  // The address is required even when this page was served by the server being
  // added: nothing here assumes the origin it is hosted on.
  const apiUrl = normalizeUrl(url)
  const complete = !!(trimmedName && apiUrl && trimmedKey)

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault()
    if (!complete || checking) return
    setError(null)

    // probeServer returns a result rather than throwing, so the thunk below
    // turns its failure into one — errorMessage reads `.message` straight
    // off it, and onError keeps the failure inline instead of a toast: this
    // is a field the user is still looking at, not a fire-and-forget write.
    return run(
      async () => {
        const result = await probeServer(apiUrl, trimmedKey)
        if (!result.ok) throw new Error(result.message)
        return result
      },
      {
        onError: setError,
        // Nothing is written until the server has answered for itself.
        onSuccess: () => {
          onSaved({ name: trimmedName, apiUrl, apiKey: trimmedKey })
          reset()
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-0 overflow-hidden p-0"
      >
        <form onSubmit={onSubmit}>
          <div className="flex items-center justify-between border-b px-5 py-4">
            <DialogTitle className="text-[15px] leading-normal font-semibold">Add server</DialogTitle>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close"
                className="size-10 text-muted-foreground"
              >
                <X className="size-[15px]" />
              </Button>
            </DialogClose>
          </div>

          <div className="flex flex-col gap-[22px] p-5">
            <ServerField label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. prod"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </ServerField>

            <ServerField label="Server URL">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://linq.yourcompany.com"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                className={inputClass}
              />
            </ServerField>

            <ServerField label="API key">
              <div className="relative">
                <Input
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="linq_..."
                  type={revealed ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputClass} pr-11`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setRevealed((shown) => !shown)}
                  aria-label={revealed ? "Hide API key" : "Show API key"}
                  className="absolute top-1.5 right-1.5 text-muted-foreground"
                >
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
              </div>
            </ServerField>

            {error ? (
              <p
                className="-mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2.5 border-t px-5 py-4">
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 px-4 text-[13.5px] text-muted-foreground"
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={!complete || checking}
              className="h-9 px-4 text-[13.5px] hover:bg-primary/90 disabled:opacity-40"
            >
              {checking ? "Checking…" : "Add server"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const inputClass = "h-11 bg-background px-3.5 md:text-sm"

function ServerField({ label, children }: { label: string; children: ReactNode }) {
  return (
    // The control is the child, which the wrapping label associates implicitly.
    <Label className="flex-col items-stretch gap-2 text-[13px] leading-normal font-semibold">
      <span>{label}</span>
      {children}
    </Label>
  )
}
