/** Anything a serialised log line can be handed to. Tests pass an array-backed one. */
export type Sink = { write(line: string): void }
