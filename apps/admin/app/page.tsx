"use client"

import { useRouter } from "next/navigation"
import { type SyntheticEvent, useEffect, useState } from "react"
import { Field } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api, getKey, setKey } from "../lib/api"

/**
 * The login screen, and the only page that works without a key.
 *
 * linq has no passwords: a user never signs in, it acts through a key an admin
 * minted. So "logging in" is pasting that key and checking it against `/me`
 * before storing it, which turns a typo into an error here rather than a broken
 * page later.
 */
export default function LoginPage() {
  const router = useRouter()
  const [key, setKeyValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // Someone who still holds a valid key never sees this screen.
  useEffect(() => {
    if (getKey()) router.replace("/links/")
  }, [router])

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault()
    const candidate = key.trim()
    if (!candidate) return

    setChecking(true)
    setError(null)
    try {
      setKey(candidate)
      await api("/v1/me")
      router.replace("/links/")
    } catch (err) {
      // api() already cleared the key on a 401.
      setError(err instanceof Error ? err.message : "That key was not accepted.")
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent>
          <form onSubmit={onSubmit}>
            <h1 className="font-heading text-lg font-semibold">linq</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Paste an API key to continue. It is stored in this browser only.
            </p>

            <div className="mt-5 flex flex-col gap-4">
              <Field label="API key" hint="Starts with linq_. An admin can mint one for you.">
                <Input
                  value={key}
                  onChange={(event) => setKeyValue(event.target.value)}
                  placeholder="linq_…"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                />
              </Field>

              {error ? (
                <p
                  className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}

              <Button type="submit" disabled={checking || !key.trim()}>
                {checking ? "Checking…" : "Continue"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
