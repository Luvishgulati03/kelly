import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Multi-conversation store for the web chat.
 *
 * Storage follows the convention the single-thread transcript already used —
 * plain JSON under `<dataDir>/chats/`, 0600, re-read before every write — rather
 * than introducing a new database for a handful of small files:
 *
 *   chats/index.json        { conversations: ConversationMeta[] }
 *   chats/<id>.json         { messages: ChatMessage[] }
 *
 * MIGRATION: the pre-existing transcript lived at `chats/web-chat.json`. It is
 * adopted in place as the conversation whose id IS "web-chat" — the file is never
 * moved, rewritten, or renamed, so nothing already on disk is orphaned, and the
 * provider-side surface session it belongs to ("web-chat") keeps working exactly
 * as before. Conversations created after the migration get their own id, their own
 * file, and their own provider surface ("web-chat:<id>").
 */

export interface ChatAttachmentRef {
  id: string;
  name: string;
  mime: string;
}

export interface ChatMessage {
  role: "user" | "henry";
  text: string;
  at: string;
  /** Images the user attached to this turn (local ids; see src/dashboard/attachments.ts). */
  attachments?: ChatAttachmentRef[];
  /** Skill that was active for this turn, if any. */
  skill?: string;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Provider surface used for this conversation's session (see ProviderRunner#acquireSession). */
  surface: string;
}

/** The id the legacy single-thread transcript is adopted under. */
export const LEGACY_CONVERSATION_ID = "web-chat";
/** Per-conversation transcript cap — same reasoning (and number) as the old single transcript. */
export const CONVERSATION_MESSAGE_CAP = 400;
export const MAX_TITLE_LENGTH = 80;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isConversationId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Derives a readable title from the first user message; falls back to "New chat". */
export function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.text.trim());
  if (!first) return "New chat";
  return normalizeTitle(first.text);
}

export function normalizeTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
}

function isChatMessage(item: unknown): item is ChatMessage {
  if (!item || typeof item !== "object") return false;
  const candidate = item as ChatMessage;
  return (candidate.role === "user" || candidate.role === "henry") && typeof candidate.text === "string";
}

export class ConversationStore {
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * Per-conversation clear generation. Same guard the single transcript had: a send
   * that finishes AFTER the conversation was cleared (or deleted) must not resurrect
   * its stale reply — the send handler records the generation up front and its final
   * append is skipped, inside the lock, once a clear has bumped it.
   */
  private generations = new Map<string, number>();

  constructor(private readonly dataDir: string) {}

  private dir(): string { return path.join(this.dataDir, "chats"); }
  private indexPath(): string { return path.join(this.dir(), "index.json"); }
  private filePath(id: string): string { return path.join(this.dir(), `${id}.json`); }

  generation(id: string): number { return this.generations.get(id) ?? 0; }

  /** Serializes every mutation, so a read-then-write append can never drop a concurrent one. */
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation);
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async readIndexFile(): Promise<ConversationMeta[] | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.indexPath(), "utf8")) as { conversations?: unknown };
      if (!Array.isArray(raw.conversations)) return undefined;
      return raw.conversations.filter((item): item is ConversationMeta =>
        !!item && typeof item === "object"
        && typeof (item as ConversationMeta).id === "string"
        && isConversationId((item as ConversationMeta).id)
        && typeof (item as ConversationMeta).title === "string");
    } catch { return undefined; }
  }

  /**
   * Reads the index, building it on first use. When the legacy `web-chat.json`
   * transcript exists it is adopted (never moved) so no existing history is lost.
   */
  private async loadIndex(): Promise<ConversationMeta[]> {
    const existing = await this.readIndexFile();
    if (existing) return existing;
    const migrated: ConversationMeta[] = [];
    const legacy = await this.readMessagesFile(LEGACY_CONVERSATION_ID);
    if (legacy.length) {
      const at = legacy[legacy.length - 1]?.at || new Date().toISOString();
      migrated.push({
        id: LEGACY_CONVERSATION_ID,
        title: titleFromMessages(legacy),
        createdAt: legacy[0]?.at || at,
        updatedAt: at,
        surface: LEGACY_CONVERSATION_ID,
      });
      await this.writeJson(this.indexPath(), { conversations: migrated });
    }
    return migrated;
  }

  private async saveIndex(conversations: ConversationMeta[]): Promise<void> {
    await this.writeJson(this.indexPath(), { conversations });
  }

  private async readMessagesFile(id: string): Promise<ChatMessage[]> {
    if (!isConversationId(id)) return [];
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath(id), "utf8")) as { messages?: unknown };
      if (!Array.isArray(raw.messages)) return [];
      return raw.messages.filter(isChatMessage);
    } catch { return []; }
  }

  /** Newest-updated first — the order the sidebar renders. */
  async list(): Promise<ConversationMeta[]> {
    const conversations = await this.locked(() => this.loadIndex());
    // Newest-updated first. ISO timestamps only resolve to a millisecond, so two
    // conversations touched in the same tick would otherwise land in an arbitrary
    // order — the index position (later = created later) is the tie-break.
    return conversations
      .map((conversation, index) => ({ conversation, index }))
      .sort((a, b) => (a.conversation.updatedAt < b.conversation.updatedAt ? 1
        : a.conversation.updatedAt > b.conversation.updatedAt ? -1
        : b.index - a.index))
      .map((entry) => entry.conversation);
  }

  async get(id: string): Promise<ConversationMeta | undefined> {
    return (await this.list()).find((conversation) => conversation.id === id);
  }

  /**
   * The body of `create` WITHOUT taking the lock — the caller must already hold it.
   * It exists so `ensureActive` can decide-and-create as one atomic step: taking the
   * lock again from inside a locked block would wait on the chain that is already
   * running and deadlock.
   */
  private async createInternal(title?: string): Promise<ConversationMeta> {
    const conversations = await this.loadIndex();
    const id = `conv_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();
    const meta: ConversationMeta = {
      id,
      title: title ? normalizeTitle(title) : "New chat",
      createdAt: now,
      updatedAt: now,
      surface: `${LEGACY_CONVERSATION_ID}:${id}`,
    };
    conversations.push(meta);
    await this.writeJson(this.filePath(id), { messages: [] });
    await this.saveIndex(conversations);
    return meta;
  }

  async create(title?: string): Promise<ConversationMeta> {
    return this.locked(() => this.createInternal(title));
  }

  /**
   * The conversation a page with no explicit selection should open — most recent, else a fresh one.
   *
   * The read and the create are ONE locked step on purpose. As two separate steps, two
   * concurrent sends both observed an empty index and each minted their own conversation;
   * their replies then landed in different transcripts, and the history endpoint — which
   * reads one — looked as though it had dropped a reply outright.
   */
  async ensureActive(): Promise<ConversationMeta> {
    return this.locked(async () => {
      const conversations = await this.loadIndex();
      const newestFirst = conversations
        .map((conversation, index) => ({ conversation, index }))
        .sort((a, b) => (a.conversation.updatedAt < b.conversation.updatedAt ? 1
          : a.conversation.updatedAt > b.conversation.updatedAt ? -1
          : b.index - a.index));
      return newestFirst[0]?.conversation ?? await this.createInternal();
    });
  }

  async rename(id: string, title: string): Promise<ConversationMeta | undefined> {
    return this.locked(async () => {
      const conversations = await this.loadIndex();
      const meta = conversations.find((conversation) => conversation.id === id);
      if (!meta) return undefined;
      meta.title = normalizeTitle(title);
      meta.updatedAt = new Date().toISOString();
      await this.saveIndex(conversations);
      return meta;
    });
  }

  /** Deletes the conversation and its transcript file. Returns false when it never existed. */
  async remove(id: string): Promise<boolean> {
    return this.locked(async () => {
      const conversations = await this.loadIndex();
      const index = conversations.findIndex((conversation) => conversation.id === id);
      if (index < 0) return false;
      conversations.splice(index, 1);
      this.generations.set(id, this.generation(id) + 1);
      await this.saveIndex(conversations);
      if (isConversationId(id)) await fs.rm(this.filePath(id), { force: true });
      return true;
    });
  }

  async messages(id: string): Promise<ChatMessage[]> {
    return this.readMessagesFile(id);
  }

  /** Empties one conversation's transcript without deleting the conversation itself. */
  async clear(id: string): Promise<void> {
    await this.locked(async () => {
      const conversations = await this.loadIndex();
      const meta = conversations.find((conversation) => conversation.id === id);
      this.generations.set(id, this.generation(id) + 1);
      if (!isConversationId(id)) return;
      await this.writeJson(this.filePath(id), { messages: [] });
      if (meta) {
        meta.updatedAt = new Date().toISOString();
        await this.saveIndex(conversations);
      }
    });
  }

  /**
   * Appends messages, re-reading the file inside the lock first. `ifGeneration`
   * drops the write when the conversation was cleared or deleted meanwhile.
   */
  async append(id: string, entries: ChatMessage[], options: { ifGeneration?: number } = {}): Promise<void> {
    await this.locked(async () => {
      if (options.ifGeneration !== undefined && options.ifGeneration !== this.generation(id)) return;
      if (!isConversationId(id)) return;
      const conversations = await this.loadIndex();
      const meta = conversations.find((conversation) => conversation.id === id);
      if (!meta) return; // deleted meanwhile — never resurrect a conversation from an in-flight send
      const fresh = await this.readMessagesFile(id);
      const messages = [...fresh, ...entries].slice(-CONVERSATION_MESSAGE_CAP);
      await this.writeJson(this.filePath(id), { messages });
      meta.updatedAt = new Date().toISOString();
      // An untitled conversation names itself from its first user message, like Claude's web UI.
      if (meta.title === "New chat") meta.title = titleFromMessages(messages);
      await this.saveIndex(conversations);
    });
  }
}
