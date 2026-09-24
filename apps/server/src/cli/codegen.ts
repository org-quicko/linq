import { loadConfig } from "../config.ts"

const config = loadConfig()
const child = Bun.spawn(
  [
    "bunx",
    "--no-install",
    "kysely-codegen",
    "--dialect",
    "postgres",
    "--default-schema",
    config.LINQ_DB_SCHEMA,
    "--out-file",
    "src/db/types.generated.ts",
  ],
  { stdout: "inherit", stderr: "inherit" },
)
const exitCode = await child.exited
if (exitCode !== 0) process.exit(exitCode)
