import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Kelly Excel MCP exposes the four bounded workbook tools", { timeout: 120_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("bin/kelly-excel-mcp.mjs")],
    stderr: "pipe",
  });
  const client = new Client({ name: "kelly-mcp-test", version: "0.1.0" });
  let serverStderr = "";
  transport.stderr?.on("data", (chunk) => { serverStderr += String(chunk); });
  try {
    await client.connect(transport, { timeout: 180_000 });
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
      "excel_inspect_workbook",
      "excel_read_range",
      "excel_save_edited_copy",
      "excel_search_workbook",
    ]);
  } finally {
    await client.close();
  }
  assert.equal(serverStderr, "", serverStderr);
});
