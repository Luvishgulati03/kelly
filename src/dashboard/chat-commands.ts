/**
 * Slash commands for the web chat.
 *
 * The parser lives here (not only in the page) so the SERVER can refuse a command
 * that reaches `/api/chat/send` — an unknown command must never be silently posted
 * to the model as if it were a question, and must never be a silent no-op. The page
 * fetches this same list from `/api/chat/commands` and builds its autocomplete menu
 * from it, so the menu and the parser cannot drift apart.
 *
 * Every command is a SURFACE action (switch conversation, pick a skill, switch
 * provider). None of them can send anything outbound.
 */

export interface CommandSpec {
  name: string;
  /** Argument hint shown in the menu, e.g. "<name>". */
  args?: string;
  summary: string;
}

export const CHAT_COMMANDS: readonly CommandSpec[] = [
  { name: "new", summary: "Start a new conversation" },
  { name: "clear", summary: "Clear this conversation and reset Henry's context for it" },
  { name: "rename", args: "<title>", summary: "Rename the current conversation" },
  { name: "skill", args: "<name>", summary: "Load a skill from skills/ as guidance for the next turns" },
  { name: "provider", args: "claude|codex", summary: "Switch the provider Henry runs on" },
  { name: "model", args: "claude|codex", summary: "Alias of /provider" },
  { name: "help", summary: "List the available commands" },
];

export type ParsedCommand =
  | { kind: "none" }
  | { kind: "command"; name: string; arg: string }
  | { kind: "unknown"; name: string };

const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9_-]*)\s*([\s\S]*)$/;

export function isCommandName(name: string): boolean {
  return CHAT_COMMANDS.some((command) => command.name === name.toLowerCase());
}

/**
 * A command is only a command when the `/` starts the input. `//foo` is an escape for a
 * message that genuinely begins with a slash, and a bare `/` is nothing yet (the menu is
 * open, the user is still typing).
 */
export function parseCommand(input: string): ParsedCommand {
  const text = input.trimStart();
  if (!text.startsWith("/")) return { kind: "none" };
  if (text.startsWith("//")) return { kind: "none" };
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return { kind: "none" };
  const name = match[1].toLowerCase();
  const arg = match[2].trim();
  return isCommandName(name) ? { kind: "command", name, arg } : { kind: "unknown", name };
}

/** The text a message that starts with `//` should actually send. */
export function unescapeMessage(input: string): string {
  return input.trimStart().startsWith("//") ? input.trimStart().slice(1) : input;
}

/** The inline reply for an unknown command — explicit, never silent. */
export function unknownCommandMessage(name: string): string {
  return `Unknown command: /${name}. Type /help to see what I understand.`;
}

/** The inline reply for /help. */
export function helpMessage(): string {
  return [
    "Commands:",
    ...CHAT_COMMANDS.map((command) => `- /${command.name}${command.args ? ` ${command.args}` : ""} — ${command.summary}`),
    "Start a message with // to send text that begins with a slash.",
  ].join("\n");
}
