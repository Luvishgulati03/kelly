import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Read-only export of a configured learning corpus from Mongo into knowledge/raw/.
 * Credentials are read from the source checkout's own .env at run time and never stored.
 * Only the explicitly projected learning fields below are exported.
 */

const ORG_BACKEND = process.env.ORG_BACKEND_DIR;
const MODULES_COLLECTION = process.env.HENRY_KNOWLEDGE_MODULES_COLLECTION || "modules";
const CHUNKS_COLLECTION = process.env.HENRY_KNOWLEDGE_CHUNKS_COLLECTION || "learningchunks";
const TRANSCRIPTS_COLLECTION = process.env.HENRY_KNOWLEDGE_TRANSCRIPTS_COLLECTION || "awsmediajobs";

interface ExportCounts { chunks: number; transcripts: number; texts: number; modules: number }

/** Flattens Quill Delta / Lexical / arbitrary editor JSON into plain prose; passes plain text through. */
export function richTextToPlain(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (typeof record.insert === "string") out.push(record.insert);
        if (typeof record.text === "string") out.push(record.text);
        if (record.type === "linebreak" || record.type === "paragraph") out.push("\n");
        for (const key of ["ops", "children", "root", "content", "curriculum_content", "overview", "skills", "logistics"]) {
          if (record[key] !== undefined) walk(record[key]);
        }
      }
    };
    walk(JSON.parse(trimmed));
    const text = out.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    return text || trimmed;
  } catch { return trimmed; }
}

function dedupConsecutiveLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) if (line.trim() && line.trim() !== out[out.length - 1]?.trim()) out.push(line);
  return out.join("\n");
}

function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`;
}

export async function exportOrgKnowledge(rawDir: string): Promise<ExportCounts> {
  if (!ORG_BACKEND) throw new Error("ORG_BACKEND_DIR not set — point it at your source checkout (its apps/migrations/.env must hold DB_STRING)");
  const env = dotenv.parse(await fs.readFile(path.join(ORG_BACKEND, "apps/migrations/.env"), "utf8"));
  const uri = env.DB_STRING;
  if (!uri) throw new Error("DB_STRING not found in the backend repo's apps/migrations/.env");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { readPreference: "secondaryPreferred" });
  const counts: ExportCounts = { chunks: 0, transcripts: 0, texts: 0, modules: 0 };
  try {
    await client.connect();
    const db = client.db(env.DB_NAME || undefined);
    await fs.mkdir(path.join(rawDir, "transcripts"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(rawDir, "texts"), { recursive: true, mode: 0o700 });

    // 1. Module catalog (names, taxonomy, hierarchy) for attribution + domains.
    const modules = await db.collection(MODULES_COLLECTION).find(
      { active: { $ne: false } },
      { projection: { name: 1, subtitle: 1, description: 1, type: 1, resource_type: 1, filters: 1, slug: 1, keywords: 1, ancestry: 1 } },
    ).toArray();
    const moduleById = new Map(modules.map((m) => [String(m._id), m]));
    await fs.writeFile(path.join(rawDir, "modules.json"), JSON.stringify(modules, null, 1), "utf8");
    counts.modules = modules.length;

    // 2. Cleaned learning chunks (best-quality corpus; excludes stored embeddings).
    const chunkCursor = db.collection(CHUNKS_COLLECTION).find({ active: { $ne: false } }, { projection: { embedding: 0 } });
    const chunkLines: string[] = [];
    const chunkedModuleIds = new Set<string>();
    for await (const chunk of chunkCursor) {
      chunkedModuleIds.add(String(chunk.module_id));
      chunkLines.push(JSON.stringify(chunk));
    }
    await fs.writeFile(path.join(rawDir, "chunks.jsonl"), chunkLines.join("\n") + "\n", "utf8");
    counts.chunks = chunkLines.length;

    // 3. Flat transcripts for video modules not covered by learningchunks —
    //    latest completed transcribe job only (older jobs are stale).
    for (const module of modules) {
      const id = String(module._id);
      if (module.type !== "video" || chunkedModuleIds.has(id)) continue;
      const job = await db.collection(TRANSCRIPTS_COLLECTION).find(
        { module_id: module._id, service: "TRANSCRIBE", status: "COMPLETED", transcript: { $exists: true, $ne: "" } },
        { projection: { transcript: 1, created_at: 1 }, sort: { created_at: -1 }, limit: 1 },
      ).next();
      if (!job?.transcript) continue;
      const body = dedupConsecutiveLines(String(job.transcript));
      await fs.writeFile(
        path.join(rawDir, "transcripts", `${id}.md`),
        frontmatter({ module: module.name, moduleId: id, type: module.type, resource_type: module.resource_type, filters: module.filters }) + body + "\n",
        "utf8",
      );
      counts.transcripts += 1;
    }

    // 4. Authored text content (preread/postread/text modules).
    for (const module of modules) {
      if (!["preread", "postread", "text"].includes(String(module.type))) continue;
      const full = await db.collection(MODULES_COLLECTION).findOne({ _id: module._id }, { projection: { content: 1, preread_content: 1 } });
      const content = [richTextToPlain(String(full?.content || "")), full?.preread_content ? richTextToPlain(JSON.stringify(full.preread_content)) : ""].filter(Boolean).join("\n\n");
      if (!content.trim()) continue;
      await fs.writeFile(
        path.join(rawDir, "texts", `${String(module._id)}.md`),
        frontmatter({ module: module.name, moduleId: String(module._id), type: module.type, filters: module.filters }) + content + "\n",
        "utf8",
      );
      counts.texts += 1;
    }
    void moduleById;
    return counts;
  } finally { await client.close(); }
}
