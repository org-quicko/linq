import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// Read the port in Bun so root/workspace env files work on Windows as well
// as Unix, without relying on shell-specific parameter expansion.
const child = spawn(
  process.execPath,
  [
    "run",
    "next",
    "dev",
    "--port",
    process.env.LINQ_CLIENT_PORT || "3001",
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      NEXT_PUBLIC_BASE_PATH: process.env.LINQ_CLIENT_BASE_PATH || "/home",
    },
    stdio: "inherit",
    windowsHide: true,
  },
)

process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
child.on("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on("exit", (code) => {
  process.exitCode = code ?? 1
})
