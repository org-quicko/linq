/**
 * pino-roll ships no type declarations. Only the surface `log.ts` uses is
 * declared here; the full option set is documented in the package README.
 */
declare module "pino-roll" {
  export type RollStream = {
    write(line: string): void
    flush(callback?: (err?: Error | null) => void): void
    end(): void
  }

  export default function pinoRoll(options: {
    file: string
    size?: string | number
    frequency?: string | number
    extension?: string
    mkdir?: boolean
    limit?: { count?: number; removeOtherLogFiles?: boolean }
  }): Promise<RollStream>
}
