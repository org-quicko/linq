"use client"

import { Eye, EyeOff } from "lucide-react"
import { type SyntheticEvent, useState } from "react"
import { Field } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRun } from "../lib/hooks"
import { normalizeUrl, probeServer, type Server } from "../lib/servers"

/**
 * Adds a server, or edits one that already exists.
 *
 * Either way the details are verified before they are handed back: a record
 * that cannot answer is how a UI ends up unable to explain why nothing loads,
 * and the check costs one round trip at the only moment the user is looking.
 */
export function ServerForm({
  server,
  submitLabel = "Connect",
  onSaved,
  onCancel,
}: {
  /** Omitted when adding. */
  server?: Server
  submitLabel?: string
  onSaved: (values: { name: string; apiUrl: string; apiKey: string }) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(server?.name ?? "")
  const [url, setUrl] = useState(server?.apiUrl ?? "")
  const [apiKey, setApiKey] = useState(server?.apiKey ?? "")
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { run, saving: checking } = useRun()

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedKey = apiKey.trim()
    // The address is required even when this page was served by the server being
    // added: nothing here assumes the origin it is hosted on.
    const apiUrl = normalizeUrl(url)
    if (!trimmedName || !apiUrl || !trimmedKey) {
      setError("A name, a server URL and an API key are all needed.")
      return
    }
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
        onSuccess: () => onSaved({ name: trimmedName, apiUrl, apiKey: trimmedKey }),
      },
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <Field label="Name" hint="Whatever you want to call it.">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="prod"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field
        label="Server URL"
        hint="Where the linq server answers, e.g. https://linq.example.com."
      >
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://linq.example.com"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
      </Field>

      <Field label="API key" hint="Stored in this browser only, and sent with every request.">
        <div className="relative">
          <Input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="linq_…"
            type={revealed ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
            aria-label={revealed ? "Hide API key" : "Show API key"}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </Field>

      {error ? (
        <p
          className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={checking}>
          {checking ? "Checking…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={checking}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}
