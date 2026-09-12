#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { editWorkbook, inspectWorkbook, readRange, searchWorkbook } from "../commerce/workbooks.ts";

const server = new McpServer({ name: "kelly-excel-mcp-server", version: "0.1.0" });
const filePath = z.string().min(1).max(4096).describe("Absolute path to a local XLSX or CSV file");
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

server.registerTool("excel_inspect_workbook", {
  title: "Inspect workbook", description: "List sheets and used dimensions without changing the workbook.",
  inputSchema: { file_path: filePath }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ file_path }) => response(await inspectWorkbook(file_path)));

server.registerTool("excel_read_range", {
  title: "Read workbook range", description: "Read displayed values from one bounded sheet range without changing the workbook.",
  inputSchema: { file_path: filePath, sheet: z.string().min(1).max(128), range: z.string().regex(/^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/i) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ file_path, sheet, range }) => response(await readRange(file_path, sheet, range)));

server.registerTool("excel_search_workbook", {
  title: "Search workbook", description: "Search visible cell values across workbook sheets. Returns at most 100 matches.",
  inputSchema: { file_path: filePath, query: z.string().min(1).max(500) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ file_path, query }) => response(await searchWorkbook(file_path, query)));

server.registerTool("excel_save_edited_copy", {
  title: "Save edited workbook copy", description: "Apply explicit cell edits and save a new XLSX version. Never overwrites the source. Pass the inspected SHA-256 to reject stale edits.",
  inputSchema: {
    file_path: filePath, output_path: z.string().min(1).max(4096).optional(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    edits: z.array(z.object({ sheet: z.string().min(1).max(128), cell: z.string().regex(/^[A-Z]+[1-9]\d*$/i), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict()).min(1).max(500),
  }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ file_path, edits, output_path, expected_sha256 }) => response(await editWorkbook(file_path, edits, output_path, expected_sha256)));

const transport = new StdioServerTransport();
await server.connect(transport);
