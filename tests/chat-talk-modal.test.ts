import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium } from "playwright";

const TALK_PAGE = `<!doctype html>
<html><head><title>fake talk</title></head>
<body>
<script>
window.parent.postMessage({ type: "kelly-talk", event: "turn", conversationId: "conv_test" }, location.origin);
</script>
</body></html>`;

test("chat talk modal: overlay open/close, postMessage contract, fallback link", { timeout: 45000 }, async () => {
  const html = await fs.readFile(new URL("../src/dashboard/chat.html", import.meta.url), "utf8");
  const historyRequests: string[] = [];
  let conversationsListCalls = 0;

  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    if (url === "/chat") {
      res.setHeader("content-type", "text/html");
      res.end(html);
      return;
    }
    if (url.startsWith("/talk")) {
      res.setHeader("content-type", "text/html");
      res.end(TALK_PAGE);
      return;
    }
    if (url.startsWith("/api/chat/history")) {
      historyRequests.push(url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ conversationId: "conv_test", messages: [] }));
      return;
    }
    if (url === "/api/conversations" && req.method === "GET") {
      conversationsListCalls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ conversations: [{ id: "conv_test", title: "Test conversation" }] }));
      return;
    }
    if (url === "/api/conversations" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ conversation: { id: "conv_new", title: "New chat" } }));
      return;
    }
    if (url === "/api/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ provider: "claude" }));
      return;
    }
    if (url === "/api/chat/commands") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ commands: [] }));
      return;
    }
    if (url === "/api/skills") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ skills: [] }));
      return;
    }
    if (url === "/api/agents") {
      res.writeHead(404).end();
      return;
    }
    if (url === "/api/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://**/*", (route) => route.abort());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/chat`);

    // Wait for the initial conversation list + history to land so activeId is set.
    await page.waitForFunction(() => document.querySelectorAll("#convlist .conv").length > 0);

    // Plain click opens the modal instead of navigating away.
    const requestsBeforeTurn = historyRequests.length;
    await page.getByRole("link", { name: "Talk" }).click();
    await page.waitForSelector("#talkModal[open]");
    const src = await page.locator("#talkFrame").getAttribute("src");
    assert.ok(src && src.startsWith("/talk?embed=1"), `iframe src should start with /talk?embed=1, got ${src}`);
    assert.ok(src && src.includes("captions=1"), `iframe src should include captions=1, got ${src}`);
    assert.ok(src && src.includes("conversationId=conv_test"), `iframe src should include the active conversation, got ${src}`);
    assert.equal(page.url(), `${base}/chat`, "the top-level page never navigated away");

    // The fake /talk page posts a "turn" message; chat.html should refresh history for it.
    const deadline = Date.now() + 5000;
    while (historyRequests.length <= requestsBeforeTurn && Date.now() < deadline) {
      await page.waitForTimeout(50);
    }
    assert.ok(historyRequests.length > requestsBeforeTurn, "the turn event triggered a fresh history request");
    assert.ok(
      historyRequests.slice(requestsBeforeTurn).some((url) => url.includes("conversationId=conv_test")),
      `expected a history request for conv_test after the turn event, got ${JSON.stringify(historyRequests.slice(requestsBeforeTurn))}`,
    );
    assert.ok(await page.locator("#talkModal[open]").count(), "modal stays open after a turn event");

    const requestsBeforeForeignMessage = historyRequests.length;
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "kelly-talk", event: "turn", conversationId: "conv_evil" },
          origin: "https://evil.example",
        }),
      );
    });
    await page.waitForTimeout(100);
    assert.equal(historyRequests.length, requestsBeforeForeignMessage, "a message from a foreign origin must be ignored");
    assert.ok(!historyRequests.some((url) => url.includes("conv_evil")), "the foreign-origin conversationId must never be adopted");

    // Escape closes the dialog and releases the iframe (about:blank).
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !(document.getElementById("talkModal") as HTMLDialogElement).open);
    assert.equal(await page.locator("#talkFrame").getAttribute("src"), "about:blank");

    // Ctrl-click (or middle-click) must fall back to opening /talk in a new tab, not the modal.
    const [popup] = await Promise.all([
      browser.contexts()[0]?.waitForEvent("page", { timeout: 3000 }).catch(() => null),
      page.getByRole("link", { name: "Talk" }).click({ modifiers: ["Control"] }),
    ]);
    assert.equal(await page.locator("#talkModal[open]").count(), 0, "ctrl-click must not open the in-page modal");
    if (popup) await popup.close();

    assert.deepEqual(errors, []);
    void conversationsListCalls;
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
