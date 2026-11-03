/** POSIX single-quote so an arbitrary value survives the shell as one word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildAgentCommand(command: string, args: string): string {
  return [command.trim(), args.trim()].filter(Boolean).join(" ");
}

const GENERATED_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Older builds used a generated custom-agent id as the fallback command.
 * Treat only that exact UUID-shaped placeholder as empty; a deliberate custom
 * command that matches a human-readable id remains untouched. */
export function normalizeCustomAgentCommand(id: string, command: string | undefined): string {
  const value = command?.trim() ?? "";
  return GENERATED_AGENT_ID.test(id) && value === id ? "" : value;
}
