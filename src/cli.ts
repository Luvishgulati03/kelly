#!/usr/bin/env node
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HenryRuntime } from "./runtime.ts";
import { startDashboard } from "./dashboard/server.ts";
import { createUser, deleteUser, listUsers, setPassword } from "./dashboard/auth.ts";
import {
  writeCronFile, writeLaunchdPlist, installCron, installLaunchd,
  uninstallCron, uninstallLaunchd, schedulerStatus,
} from "./scheduler/install.ts";
import { parseAt, parseIn, type ReminderKind } from "./reminders/service.ts";
import { startReminderTicker, type ReminderTickerHandle } from "./reminders/ticker.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { createInputQueue } from "./repl/input-queue.ts";
import { executeExplicitApproval } from "./approval/explicit.ts";
import { trackerSummary } from "./mailwatch/tracker.ts";
import { dim } from "./tui/ansi.ts";
import { createRenderer, renderMarkdown } from "./tui/markdown.ts";
import {
  type CommandSpec, type PanelRow, banner, clearLine, commandPanel, note, panel,
  prompt as promptFor, spinnerStart, spinnerTick,
} from "./tui/panel.ts";
import { isLongResearchAsk } from "./orchestration/luna.ts";
import { getActiveProfile, isServiceExcluded, setActiveProfile } from "./profile.ts";
import { runCommerceCommand } from "./commerce/commands.ts";
import { runDesignsCommand } from "./designs/commands.ts";
import {
  TUNNEL_CONNECT_TIMEOUT_MS, TUNNEL_STILL_CONNECTING_MESSAGE,
  connectedLines, failedLine, waitForFirstTunnelTransition, watchTunnelTransitions,
  type TunnelAnnounceLine,
} from "./remote/announce.ts";

// `node bin/kelly.mjs` sets the process's active profile before importing this module. But
// Kelly's own agent prompt tells the model to run commands as `npx tsx src/cli.ts <cmd>`
// directly (no launcher) — and Codex's shell tool inherits the running server's environment,
// including AGENT_PROFILE=kelly, when it does. Without this, that direct invocation silently
// keeps the default "henry" profile, config.ts reads HENRY_* env vars instead of KELLY_*, and
// the CLI resolves a different (usually empty) data directory than the server it was spawned
// from — e.g. `designs search`/`designs stats` seeing zero rows while the dashboard sees many.
if (process.env.AGENT_PROFILE === "kelly") setActiveProfile("kelly");

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function restAfter(command: string): string[] {
  const index = args.indexOf(command);
  return index < 0 ? [] : args.slice(index + 1).filter((item, itemIndex, values) => {
    const previous = values[itemIndex - 1];
    return previous !== "--repo" && previous !== "--cwd" && previous !== "--provider";
  });
}

function print(value: unknown): void {
  if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2));
}

/** All of stdin, read to EOF, with a single trailing newline trimmed (the shape `--password-stdin` expects). */
async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Terminal password prompt with the typed characters never echoed: readline (in terminal
 * mode) writes every keystroke's echo to the `output` stream it was given rather than
 * relying on the kernel tty, so routing that stream through a Writable that swallows every
 * write hides the password while readline's own line-editing (backspace, etc.) still works.
 */
function promptHiddenPassword(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(promptText);
    const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const rl = readline.createInterface({ input, output: mutedOutput, terminal: true });
    rl.question("").then((answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    }).catch((error) => { rl.close(); reject(error); });
  });
}

/** `--password-stdin` reads the whole password from stdin; otherwise it is typed with hidden echo. */
async function resolvePassword(): Promise<string> {
  if (args.includes("--password-stdin")) {
    const raw = await readStdinAll();
    if (!raw) throw new Error("--password-stdin was set but stdin was empty");
    return raw;
  }
  return promptHiddenPassword("Password: ");
}

/**
 * Keeps `{profile} gmail …` as the explicit integration namespace while also giving the
 * common mail-drafting workflows a short, discoverable `{profile} draft …` alias. Both
 * paths deliberately land on guarded implementations: automatic replies write a local
 * copy and stage threaded approval items; manual mail is staged in the same queue.
 * Neither path sends without an explicit approval; Gmail operations use Codex's connector.
 */
async function runGmailCommand(runtime: HenryRuntime, sub: string): Promise<void> {
  if (!runtime.gmail) throw new Error("Gmail is not available in this profile");
  if (sub === "inbox") print(await runtime.gmail.inbox(Number(option("--limit") || 10)));
  else if (sub === "send" || sub === "draft" || sub === "reply") {
    const to = option("--to");
    const subject = option("--subject");
    const body = option("--body") || args.slice(2).filter((item) => !item.startsWith("--") && item !== to && item !== subject).join(" ");
    if (!to || !subject || !body) throw new Error("Usage: henry draft mail --to email --subject subject --body body");
    const item = await runtime.gmail.queueEmail({
      to, subject, body,
      threadId: option("--thread-id"),
      inReplyTo: option("--in-reply-to") || option("--message-id"),
      references: option("--references"),
    });
    print({ message: "Saved locally and queued for Taylor's approval", approvalId: item.id, dashboard: `http://${runtime.config.host}:${runtime.config.port}` });
  } else if (sub === "draftreplies") {
    if (!runtime.draftReplies) throw new Error("draftreplies command is not available in this profile");
    const limit = Number(option("--limit")) || 5;
    const result = await runtime.draftReplies.draftReplies(limit);
    print({
      drafted: result.drafted,
      staged: result.staged,
      skipped: result.skipped,
      localPath: result.localPath,
      message: result.staged.length
        ? `Prepared ${result.staged.length} threaded approval item(s); nothing sent. Review the approvals and local draft at ${result.localPath}`
        : result.drafted.length
          ? `Wrote ${result.drafted.length} local reply draft(s); no Gmail draft or message was created`
          : "No replies needed",
    });
  } else throw new Error("Usage: henry gmail inbox|draft|reply|draftreplies");
}

/**
 * Agent prose inside the REPL goes through the markdown-lite renderer. With color off
 * `renderMarkdown` is the identity function, so this stays `console.log`-equivalent.
 */
function printAgentText(text: string): void {
  const rendered = renderMarkdown(text);
  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

/**
 * The REPL's commands, declared ONCE. `:help` is generated from this table, so help
 * can no longer drift from what the loop below actually dispatches (the old hand-written
 * one-liner had already lost `:queue` and `:pm`). Keep a command and its row together.
 */
const REPL_COMMANDS: CommandSpec[] = [
  { group: "session", name: ":help", summary: "this panel" },
  { group: "session", name: ":status", summary: "provider, dashboard, approvals, memory" },
  { group: "session", name: ":dashboard", summary: "print the dashboard URL" },
  { group: "session", name: ":queue", summary: "what is buffered while thinking" },
  { group: "session", name: ":quit", summary: "finish the current reply, then exit (:exit too)" },
  { group: "brain", name: ":memory", args: "<query>", summary: "search memory" },
  { group: "brain", name: ":provider", args: "[codex|claude]", summary: "show or switch the primary provider" },
  { group: "brain", name: ":pm", args: "on|off", summary: "project-manager mode (PMBOK-grounded)" },
];

/** `:help` — the table above, in a panel. */
function helpPanel(): string {
  const profile = getActiveProfile();
  return commandPanel(`${profile.name.toLowerCase()} · commands`, REPL_COMMANDS);
}

/** Flattens `runtime.status()` into panel rows: nested objects become an indented block. */
function statusRows(status: Record<string, unknown>): PanelRow[] {
  const scalar = (value: unknown): string => (value === null || value === undefined ? "—" : String(value));
  const rows: PanelRow[] = [];
  for (const [key, value] of Object.entries(status)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push({ heading: key });
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        rows.push({
          key: `  ${inner}`,
          value: innerValue && typeof innerValue === "object" ? JSON.stringify(innerValue) : scalar(innerValue),
        });
      }
      continue;
    }
    rows.push({ key, value: Array.isArray(value) ? value.join(", ") : scalar(value) });
  }
  return rows;
}

/** Telegram's boot-banner segment — the same state `announceTelegramPump` narrates. */
function telegramStatus(state: { armed: boolean; bridge: boolean; standup: boolean }): string {
  if (!state.armed) return "telegram: off";
  const surfaces = [state.bridge ? "DM" : "", state.standup ? "group" : ""].filter(Boolean);
  return `telegram: ${surfaces.length ? surfaces.join(" + ") : "idle"}`;
}

/**
 * Taylor's rule: the dashboard comes up with every interactive Henry, not just `henry dashboard`.
 * It must never take the REPL down with it. `startDashboard` throws synchronously on a bad
 * remote-host config, and `server.listen` emits EADDRINUSE asynchronously when a second Henry
 * (or the scheduler daemon) already holds the port — with no handler that's an uncaught
 * exception. Both degrade to one printed line here. `HENRY_NO_DASHBOARD=1` opts out entirely.
 */
function startDashboardBeside(runtime: HenryRuntime): void {
  if (process.env.HENRY_NO_DASHBOARD === "1") return;
  const url = `http://${runtime.config.host}:${runtime.config.port}`;
  try {
    const server = startDashboard(runtime);
    server.on("listening", () => console.log(note("ok", `Henry dashboard: ${url}`)));
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") console.log(note("ok", `Henry dashboard: ${url} (already running — reusing it)`));
      else console.log(note("warn", `Henry dashboard unavailable: ${error.message}`));
    });
  } catch (error) {
    console.log(note("warn", `Henry dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }
}

/** One line for the one Telegram reader — says which consumers it actually routes to. */
function announceTelegramPump(state: { armed: boolean; bridge: boolean; standup: boolean }): void {
  if (!state.armed) return;
  const surfaces = [state.bridge ? "your DM (two-way)" : "", state.standup ? "the team group" : ""].filter(Boolean);
  console.log(note("info", `Telegram: watching ${surfaces.join(" + ")}.`));
}

function printTunnelLine(line: TunnelAnnounceLine): void {
  console.log(line.level === "info" ? line.text : note(line.level, line.text));
}

/**
 * Starts the remote-access tunnel (src/remote/tunnel.ts) once the dashboard is up. A no-op
 * when KELLY_TUNNEL is unset or "off". Never throws — a broken tunnel must not take the
 * dashboard or the repl down with it.
 *
 * Cloudflare mode's start() returns before cloudflared has actually registered the tunnel
 * (see tunnel.ts's spawnCloudflared), so a status of "not active, no error" right after
 * start() means "still connecting", never "did not start": this prints a placeholder line and
 * waits (up to TUNNEL_CONNECT_TIMEOUT_MS) for the tunnel's first real status transition before
 * reporting connected/failed/still-connecting. It then keeps watching for later drop/reconnect
 * transitions (src/remote/announce.ts) for the rest of this process's life, printing at most
 * one line per real change — never once per health-loop tick.
 */
async function announceTunnel(runtime: HenryRuntime): Promise<void> {
  if ((process.env.KELLY_TUNNEL || "off") === "off") return;
  try {
    const tunnel = runtime.tunnel;
    const status = await runtime.startTunnel();
    let finalStatus = status;

    if (status.active && status.url) {
      for (const line of connectedLines(status, false)) printTunnelLine(line);
    } else if (status.lastError) {
      printTunnelLine(failedLine(status.lastError, false));
    } else {
      printTunnelLine({ level: "info", text: "Connecting remote access..." });
      const first = await waitForFirstTunnelTransition(tunnel, TUNNEL_CONNECT_TIMEOUT_MS);
      if (first === "timeout") {
        printTunnelLine({ level: "warn", text: TUNNEL_STILL_CONNECTING_MESSAGE });
      } else {
        finalStatus = first.status;
        if (first.kind === "remote.started" && first.status.active) {
          for (const line of connectedLines(first.status, false)) printTunnelLine(line);
        } else {
          printTunnelLine(failedLine(first.status.lastError ?? "not connected yet", false));
        }
      }
    }

    watchTunnelTransitions(tunnel, finalStatus.active, printTunnelLine);
  } catch (error) {
    printTunnelLine(failedLine(error instanceof Error ? error.message : String(error), false));
  }
}

/**
 * Friday-style buffer-and-drain REPL: while an agent turn is in flight (queue.busy), new
 * lines are buffered instead of racing it. Only `:help`/`:dashboard` are "trivially safe"
 * enough to answer instantly even while busy — everything else (including `:status`/
 * `:memory`/`:provider`) buffers as raw text and, on drain, is sent to the agent as one
 * combined turn (the pure buffering logic lives in `src/repl/input-queue.ts`, testable
 * without readline).
 */
async function repl(
  runtime: HenryRuntime,
  reminderTicker?: ReminderTickerHandle,
  setRedraw?: (fn: () => void) => void,
  bootStatus: string[] = [],
): Promise<void> {
  const queue = createInputQueue();
  const rl = readline.createInterface({ input, output, prompt: promptFor() });
  // Reminders fired by the in-process ticker print here, above the prompt.
  let rlClosed = false;
  rl.once("close", () => { rlClosed = true; });
  // The prompt is re-derived on every draw so a queued turn shows as `… ❯ ` without
  // any new state — `queue.busy` already is the state. (Plain mode: `henry> `, as before.)
  const safePrompt = (preserve = false): void => {
    if (rlClosed) return;
    rl.setPrompt(promptFor({ queued: queue.busy }));
    rl.prompt(preserve);
  };
  setRedraw?.(() => safePrompt(true));
  // Status line stays short enough that even the plain one-line fallback fits 80 columns.
  console.log(banner({ status: [...bootStatus, "type :help"] }));

  let quitting = false;

  async function runAgentTurn(value: string, label?: string): Promise<void> {
    const approvalResult = await executeExplicitApproval(runtime, value);
    if (approvalResult !== undefined) {
      if (label) console.log(dim(label));
      printAgentText(approvalResult);
      return;
    }
    if (isLongResearchAsk(value)) {
      const turn = runtime.startInteractiveTurn(value, { surface: "repl" });
      if (turn.delegated) {
        if (label) console.log(dim(label));
        printAgentText(turn.acknowledgement);
        void turn.completion.then((result) => {
          console.log();
          console.log(dim("Luna research report"));
          printAgentText(result.exitCode === 0 && result.response.trim()
            ? result.response
            : `Research failed: ${result.error ?? `Codex exited ${String(result.exitCode)}`}`);
          safePrompt(true);
        }).catch((error) => {
          console.error(note("err", `Research failed: ${error instanceof Error ? error.message : String(error)}`));
          safePrompt(true);
        });
        return;
      }
    }
    // Streaming display (latency plan #1/#6): print provider text as it
    // arrives; the spinner shows elapsed seconds until the first token lands.
    const started = Date.now();
    let streamedChars = 0;
    // Markdown-lite skin for the stream (docs/tui-design.md §4). It buffers by LINE
    // only, so a fence or a `**` split across two provider events still styles right,
    // and nothing is ever held back longer than the line it belongs to. With color
    // off it is the identity function — piped Henry keeps its old bytes.
    const renderer = createRenderer();
    // The spinner's \r-rewrite and readline's echo fight over the same terminal
    // line — typing mid-think LOOKED dead (input visually erased every second)
    // even though the queue captured it. Truce: on the user's first keypress the
    // spinner goes silent for the rest of the run and the line is handed back as
    // a preserved prompt, so queueing is visible while Henry thinks.
    let userTyping = false;
    const onKeypress = (_ch: unknown, key: { name?: string } | undefined): void => {
      if (userTyping || key?.name === "return" || key?.name === "enter") return;
      userTyping = true;
      setImmediate(() => { process.stdout.write(clearLine()); safePrompt(true); });
    };
    input.on("keypress", onKeypress);
    let tick = 0;
    const spinner = setInterval(() => {
      if (streamedChars === 0 && !userTyping) {
        process.stdout.write(`\r${spinnerTick(tick++, Math.round((Date.now() - started) / 1000))}`);
      }
    }, 1000);
    process.stdout.write(spinnerStart());
    try {
      const result = await runtime.agent.run(value, { surface: "repl",
        onEvent: (event) => {
          const text = event.parsed && typeof (event.parsed as Record<string, unknown>).text === "string"
            ? String((event.parsed as Record<string, unknown>).text)
            : undefined;
          if (!text?.trim()) return;
          if (streamedChars === 0) {
            // If the user owns the line, keep their draft intact above and stream below.
            process.stdout.write(userTyping ? "\n" : clearLine());
            if (label) console.log(dim(label));
          }
          process.stdout.write(renderer.write(text.endsWith("\n") ? text : text + "\n"));
          streamedChars += text.length;
        },
      });
      process.stdout.write(renderer.flush());
      if (streamedChars === 0) {
        process.stdout.write(clearLine());
        if (label) console.log(dim(label));
        printAgentText(result.response);
      } else if (result.response.length > streamedChars + 80) {
        // The final joined response contained more than what streamed — print the remainder context safely.
        console.log();
      }
    } catch (error) {
      process.stdout.write(renderer.flush()); // never swallow a half-streamed line
      console.log();
      console.error(note("err", error instanceof Error ? error.message : String(error)));
    } finally {
      clearInterval(spinner);
      input.removeListener("keypress", onKeypress);
    }
  }

  // Ends the current run; if lines queued up while it was thinking, drains them into ONE
  // combined follow-up turn (recursing until the queue is empty), then prompts or exits.
  async function afterRun(): Promise<void> {
    const drained = queue.finish();
    if (drained) {
      const label = drained.count > 1 ? `(answering ${drained.count} queued messages)` : undefined;
      queue.start();
      await runAgentTurn(drained.combined, label);
      await afterRun();
      return;
    }
    if (quitting) { rl.close(); return; }
    safePrompt();
  }

  safePrompt();
  rl.on("line", (line) => {
    const value = line.trim();
    if (quitting) return; // ignore stray input after :quit was requested
    if (!value) { safePrompt(queue.busy); return; }

    if (queue.busy) {
      if (value === ":help") { console.log(helpPanel()); safePrompt(true); return; }
      if (value === ":queue") {
        console.log(queue.length ? queue.pending().map((l, i) => dim(` ${i + 1}. ${l}`)).join("\n") : dim("queue empty"));
        safePrompt(true);
        return;
      }
      if (value === ":dashboard") { console.log(note("info", `Dashboard: http://${runtime.config.host}:${runtime.config.port}`)); safePrompt(true); return; }
      if (value === ":quit" || value === ":exit") {
        quitting = true;
        console.log(note("info", "finishing current reply, then exiting…"));
        return;
      }
      const count = queue.push(value);
      console.log(dim(`⏳ queued (${count}) — henry is still thinking`));
      safePrompt(true);
      return;
    }

    if (value === ":quit" || value === ":exit") { rl.close(); return; }
    void (async () => {
      try {
        if (value === ":help") { console.log(helpPanel()); safePrompt(); return; }
        if (value === ":dashboard") { console.log(note("info", `Dashboard: http://${runtime.config.host}:${runtime.config.port}`)); safePrompt(); return; }
        if (value === ":status") { console.log(panel("status", statusRows(await runtime.status()))); safePrompt(); return; }
        if (value.startsWith(":memory ")) { print(await runtime.memory.recall(value.slice(8))); safePrompt(); return; }
        if (value === ":provider") { console.log(note("info", `Primary provider: ${runtime.config.provider}`)); safePrompt(); return; }
        if (value.startsWith(":provider ")) { console.log(note("ok", `Primary provider set to ${await runtime.setProvider(value.slice(10).trim() as "codex" | "claude")}`)); safePrompt(); return; }
        // PM MODE toggles — ":pm on|off" plus Taylor's literal phrasing "/project manager mode".
        if (value === ":pm" || value === ":pm status") { console.log(note("info", `PM mode: ${runtime.config.pmMode ? "ON" : "off"}`)); safePrompt(); return; }
        if (value === ":pm on" || /^\/?project manager mode$/i.test(value)) { await runtime.setPmMode(true); console.log(note("ok", "PM mode ON — Henry is now your project manager (PMBOK-grounded, every decision with rationale). \":pm off\" to exit.")); safePrompt(); return; }
        if (value === ":pm off") { await runtime.setPmMode(false); console.log(note("ok", "PM mode OFF — back to regular Henry.")); safePrompt(); return; }
        queue.start();
        await runAgentTurn(value);
        await afterRun();
      } catch (error) {
        console.error(note("err", error instanceof Error ? error.message : String(error)));
        safePrompt();
      }
    })();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      reminderTicker?.stop(); // never let the poll interval keep the process alive after the REPL exits
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const command = args[0] || "repl";
  // Standalone voice tools do not need the agent runtime, memory, or a provider.
  if (command === "voice") {
    if (process.env.AGENT_PROFILE === "kelly" && process.env.HENRY_TEST_ISOLATION !== "1") {
      const dotenv = await import("dotenv");
      dotenv.config(); // Kelly reads only cwd .env; the launcher never loads Henry's repo .env.
    }
    await runVoiceCommand(args.slice(1));
    return;
  }
  const runtime = await HenryRuntime.create();
  let keepAlive = false;
  try {
    if (command === "ask") {
      const prompt = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!prompt) throw new Error("Usage: henry ask <prompt>");
      print((await runtime.agent.run(prompt, { surface: "repl", provider: option("--provider") as "codex" | "claude" | undefined })).response);
    } else if (command === "jd") {
      if (!runtime.tailor) throw new Error("jd command is not available in this profile");
      // JD → tailored resume PDF (formatting locked) + cover letter, one folder.
      const filePath = option("--file");
      let jdText = filePath ? await fs.readFile(filePath, "utf8") : args.slice(1).filter((a) => !a.startsWith("--") && a !== filePath).join(" ");
      if (jdText.trim().length < 80) {
        console.log("Paste the job description below, then a line containing only END:");
        jdText = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input });
          const buffer: string[] = [];
          rl.on("line", (line) => { if (line.trim() === "END") rl.close(); else buffer.push(line); });
          rl.on("close", () => resolve(buffer.join("\n")));
        });
      }
      console.log("tailoring resume + writing cover letter… (this takes a minute or two)");
      const out = await runtime.tailor.run(jdText);
      console.log(`\n${out.role} at ${out.company}`);
      for (const change of out.changes) console.log(`  · ${change}`);
      console.log(`\nresume: ${out.resumePdf}\ncover:  ${out.coverPdf}`);
      // Only pop Finder for a human at a terminal — automated/test invocations
      // repeatedly reopening the folder read as a runaway loop to Taylor.
      if (process.stdout.isTTY) {
        const { spawn } = await import("node:child_process");
        spawn("open", [out.dir], { stdio: "ignore" }).once("error", () => {});
      }
    } else if (command === "repl") {
      keepAlive = true;
      startDashboardBeside(runtime);
      await announceTunnel(runtime);
      const pump = runtime.startTelegramPump();
      announceTelegramPump(pump);
      // One open repl = fully alive Henry: crons (mailwatch, standups, digests, portfolio
      // stats) arm right here. Safe beside a schedule daemon — every firing takes a
      // per-workflow pid lock, so exactly one process runs it. Reminders stay on the
      // repl's own terminal-delivery ticker below (role-based lock arbitrates that).
      const armed = await runtime.scheduler.start({ reminders: false });
      if (armed.length) console.log(note("ok", `Schedules armed in this repl: ${armed.length} workflows.`));
      let redrawPrompt: () => void = () => {};
      const ticker = startReminderTicker(runtime.reminders, runtime.activity, {
        role: "repl",
        // Terminal delivery PLUS system banner + telegram: prints in the REPL above
        // the prompt, and also fires the composed operator notifier.
        notify: async (message, title) => {
          // ◆ above the prompt, then the preserved prompt is redrawn underneath it.
          process.stdout.write(`\n${note("info", message)}\n`);
          redrawPrompt();
          void runtime.notifyOperator(message, title).catch(() => undefined);
        },
        promptRunner: (prompt) => runtime.agent.run(prompt).then((result) => result.response),
        executeApproval: (approvalId) => runtime.executeApproval(approvalId),
      });
      await repl(runtime, ticker, (fn) => { redrawPrompt = fn; }, [
        runtime.config.provider,
        `http://${runtime.config.host}:${runtime.config.port}`,
        telegramStatus(pump),
      ]);
      // :quit must actually quit (audit 2026-08-09 M1): armed crons and the
      // dashboard server hold the event loop, so without an explicit exit the
      // repl became an invisible zombie that kept firing workflows.
      ticker?.stop();
      runtime.close();
      process.exit(0);
    } else if (command === "dashboard") {
      keepAlive = true;
      // The dashboard is also a long-lived Henry process. Arm the same single
      // Telegram pump here so `henry dashboard` does not leave the DM bridge
      // silently offline when no REPL is open. The pump owns one getUpdates
      // reader and its SQLite lock prevents a second Henry process from racing it.
      const pump = runtime.startTelegramPump();
      try {
        const server = startDashboard(runtime);
        server.on("error", (error: NodeJS.ErrnoException) => {
          // Same degradation as the repl path (audit 2026-08-09 L1) — a running repl
          // already holds the port, which must not crash this command.
          if (error.code === "EADDRINUSE") console.log(`Henry dashboard: http://${runtime.config.host}:${runtime.config.port} (already running — reusing it)`);
          else console.log(`Henry dashboard unavailable: ${error.message}`);
        });
      } catch (error) {
        console.log(`Henry dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      startReminderTicker(runtime.reminders, runtime.activity, {
        role: "dashboard",
        notify: runtime.notifyOperator,
        promptRunner: (prompt) => runtime.agent.run(prompt).then((result) => result.response),
        executeApproval: (approvalId) => runtime.executeApproval(approvalId),
      });
      announceTelegramPump(pump);
      console.log(`Henry dashboard: http://${runtime.config.host}:${runtime.config.port}`);
      await announceTunnel(runtime);
    } else if (command === "status") {
      print(await runtime.status());
    } else if (command === "tunnel") {
      const sub = args[1] || "status";
      if (sub === "status") print(runtime.tunnel.status());
      else if (sub === "start") print(await runtime.startTunnel());
      else if (sub === "stop") { await runtime.tunnel.stop(); print(runtime.tunnel.status()); }
      else if (sub === "setup") {
        // `kelly tunnel setup <hostname> [--name kelly-test]` puts Kelly on the owner's own
        // Cloudflare domain; `kelly tunnel setup --status` reports readiness without changing
        // anything. See src/remote/cloudflare-setup.ts.
        const setupArgs = args.slice(2);
        const { runCloudflareTunnelSetup, runCloudflareTunnelStatus, createDefaultCloudflareSetupDeps } = await import("./remote/cloudflare-setup.ts");
        const deps = createDefaultCloudflareSetupDeps();
        if (setupArgs.includes("--status")) {
          await runCloudflareTunnelStatus(deps);
        } else {
          const hostname = setupArgs[0] && !setupArgs[0].startsWith("--") ? setupArgs[0] : undefined;
          if (!hostname) throw new Error("Usage: kelly tunnel setup <hostname> [--name kelly-test]");
          const nameIndex = setupArgs.indexOf("--name");
          const name = nameIndex >= 0 ? setupArgs[nameIndex + 1] : undefined;
          await runCloudflareTunnelSetup(hostname, { name }, deps);
        }
      }
      else throw new Error("Usage: henry tunnel status|start|stop|setup");
    } else if (command === "users") {
      // --demo boutique|electrical targets the same data dir `kelly start --demo --trade <t>`
      // resolves (bin/start.mjs), so the owner can create the demo's own accounts. Auth storage
      // (dashboard/auth.ts) reads the active profile's own DATA_DIR first (KELLY_DATA_DIR, which
      // bin/kelly.mjs defaults to ~/.kelly/data) and then HENRY_DATA_DIR, so both are set.
      const demoTrade = option("--demo");
      if (demoTrade !== undefined && demoTrade !== "boutique" && demoTrade !== "electrical") {
        throw new Error("--demo requires boutique or electrical");
      }
      if (demoTrade) {
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
        const demoDataDir = path.join(repoRoot, "data", demoTrade === "boutique" ? "demo-boutique" : "demo", "data");
        process.env.KELLY_DATA_DIR = demoDataDir;
        process.env.HENRY_DATA_DIR = demoDataDir;
        console.log(note("info", `Using demo (${demoTrade}) data dir: ${demoDataDir}`));
      }
      const sub = args[1];
      if (sub === "add") {
        const username = args[2];
        const role = option("--role");
        if (!username || username.startsWith("--") || (role !== "admin" && role !== "counter")) {
          throw new Error("Usage: henry users add <username> --role admin|counter [--password-stdin]");
        }
        const password = await resolvePassword();
        createUser({ username, password, role });
        console.log(`Created user ${username} (${role}).`);
      } else if (sub === "list") {
        print(listUsers());
      } else if (sub === "remove") {
        const username = args[2];
        if (!username) throw new Error("Usage: henry users remove <username>");
        console.log(deleteUser(username) ? `Removed user ${username}.` : `No such user: ${username}`);
      } else if (sub === "set-password") {
        const username = args[2];
        if (!username) throw new Error("Usage: henry users set-password <username> [--password-stdin]");
        const password = await resolvePassword();
        console.log(setPassword(username, password) ? `Password updated for ${username}.` : `No such user: ${username}`);
      } else {
        throw new Error("Usage: henry users add <username> --role admin|counter [--demo boutique|electrical] | list | remove <username> | set-password <username>");
      }
    } else if (command === "memory") {
      const sub = args[1] || "search";
      if (sub === "search") print(await runtime.memory.recall(args.slice(2).join(" ")));
      else if (sub === "remember") print(await runtime.memory.remember(args.slice(2).join(" ")));
      else if (sub === "index") print(await runtime.memory.index(args.includes("--fresh")));
      else if (sub === "graph") print(runtime.memory.graph());
      else if (sub === "dream") print(await runtime.memory.dream());
      else throw new Error("Usage: henry memory search|remember|index|graph|dream");
    } else if (command === "code" || command === "task") {
      const task = restAfter(command).filter((item) => !item.startsWith("--")).join(" ");
      if (!task) throw new Error("Usage: henry code <task> [--cwd /path/to/repository]");
      print((await runtime.task(task, option("--cwd"))).response);
    } else if (command === "provider") {
      const target = args[1];
      if (!target) print({ provider: runtime.config.provider });
      else print({ provider: await runtime.setProvider(target as "codex" | "claude") });
    } else if (command === "jobs") {
      if (!runtime.jobs) throw new Error("jobs command is not available in this profile");
      const sub = args[1] || "list";
      if (sub === "inspect") {
        if (!args[2]) throw new Error("Usage: henry jobs inspect <url>");
        print(await runtime.jobs.inspect(args[2]));
      } else if (sub === "prepare") {
        if (!args[2] || args[2].startsWith("--")) throw new Error("Usage: henry jobs prepare <url> [--resume PATH]");
        const resumePath = option("--resume");
        if (args.includes("--resume") && (!resumePath?.trim() || resumePath.startsWith("--"))) {
          throw new Error("Usage: henry jobs prepare <url> [--resume PATH]; --resume requires a path");
        }
        const draft = await runtime.jobs.prepare(args[2], undefined, resumePath);
        print({
          applicationId: draft.id, status: draft.status, approvalId: draft.approvalId,
          resumePdf: draft.resumePdfPath, missingFacts: draft.missingFacts,
          resumeEdits: draft.resumeEditsPath, independentlyReviewed: draft.review?.accepted === true,
          next: `Review it, then: henry approve approve ${draft.approvalId} && henry approve send ${draft.approvalId}`,
        });
      } else if (sub === "list") {
        print({ summary: await runtime.jobs.store.summary(), applications: (await runtime.jobs.store.list()).map((item) => ({ id: item.id, title: item.posting.title, company: item.posting.company, status: item.status, approvalId: item.approvalId })) });
      } else if (sub === "fill") {
        if (!args[2]) throw new Error("Usage: henry jobs fill <application-id>");
        print(await runtime.jobs.fill(args[2]));
      } else if (sub === "login") {
        // One-time session grant for the morning scout: Naukri + X tabs in a headed
        // window on the persistent profile. Taylor logs in, closes the window, done.
        // TTY guard (2026-08-10): typed into Henry's CHAT, this command runs inside a
        // short-lived agent turn whose exit kills the browser mid-login — the
        // "window closes after 5 seconds" mystery. A human login needs a human terminal.
        if (!process.stdout.isTTY) {
          throw new Error("jobs login is interactive — run it in your own terminal (a plain zsh prompt, not Henry's chat). The browser must outlive this process.");
        }
        console.log("Opening a browser window with Naukri + X login tabs…");
        await runtime.jobScout.login();
        console.log("Sessions saved. The morning scout (and `henry jobs scout`) can now search as you.");
      } else if (sub === "scout") {
        const prepare = Number(option("--prepare")) || 0;
        const scouted = await runtime.jobScout.scout({ prepare });
        print(scouted);
        if (scouted.needsLogin) console.log("\nGrant sessions once with: henry jobs login");
        else if (scouted.filePath) console.log(`\nShortlist: ${scouted.filePath}`);
      } else if (sub === "linkedin-cookie") {
        if (!process.stdout.isTTY) throw new Error("linkedin-cookie is interactive — run it in your own terminal.");
        const rl = readline.createInterface({ input, output });
        const value = await rl.question("Paste your li_at cookie value (real Chrome → DevTools → Application → Cookies → linkedin.com): ");
        rl.close();
        const imported = await runtime.jobScout.importLinkedInCookie(value);
        console.log(imported.ok ? "LinkedIn session imported and verified — the scout can now search as you." : `Import failed: ${imported.reason}`);
      } else if (sub === "alerts-sync") {
        const { syncAlertsFromMail } = await import("./jobs/alerts.ts");
        const learned = await syncAlertsFromMail(runtime.config, runtime.activity, runtime.agent.providerRunner);
        if (learned.titles.length === 0) console.log("No job-alert emails found in the last 45 days — scout keeps using HENRY_JOB_SCOUT_TITLES.");
        else {
          console.log(`Learned ${learned.titles.length} saved searches — the scout now targets these:`);
          for (const alert of learned.alerts.slice(0, learned.titles.length)) console.log(`  - ${alert.title} · ${alert.location} (${alert.source})`);
          const dropped = learned.alerts.length - learned.titles.length;
          if (dropped > 0) console.log(`  (…and ${dropped} more learned but NOT searched — capped at ${learned.titles.length} titles/pass to keep the LinkedIn volume rail honest)`);
          console.log(`Profile: ${learned.profilePath}`);
        }
      } else throw new Error("Usage: henry jobs inspect <url>|prepare <url> [--resume PATH]|list|fill <application-id>|login|linkedin-cookie|scout [--prepare N]|alerts-sync  (submission goes through henry approve; LinkedIn submission is blocked by design)");
    } else if (command === "cover") {
      if (!runtime.cover) throw new Error("cover command is not available in this profile");
      const sub = args[1];
      if (sub === "import") {
        if (!args[2]) throw new Error("Usage: henry cover import <path-to-resume.docx|.md|.txt>");
        print({ resumePath: await runtime.cover.importResume(args[2]) });
      } else {
        const input = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
        if (!input) throw new Error("Usage: henry cover <job-url | jd-file | jd-text>  (or: henry cover import <resume-file>)");
        print(await runtime.cover.generate(input));
      }
    } else if (command === "resume") {
      if (!runtime.resumeEditor) throw new Error("resume command is not available in this profile");
      const sub = args[1];
      if (sub === "edit") {
        const instructions = args.slice(2).filter((item) => !item.startsWith("--")).join(" ");
        if (!instructions) throw new Error("Usage: henry resume edit <instructions...>");
        print(await runtime.resumeEditor.edit(instructions));
      } else if (sub === "promote") {
        if (!args[2]) throw new Error("Usage: henry resume promote <markdown-path>");
        print({ resumePath: await runtime.resumeEditor.promote(args[2]) });
      } else if (sub === "show") {
        const text = await fs.readFile(runtime.config.resumeSourcePath, "utf8").catch(() => "");
        print({ resumePath: runtime.config.resumeSourcePath, preview: text.split(/\r?\n/).slice(0, 10).join("\n") });
      } else throw new Error("Usage: henry resume edit <instructions...>|promote <markdown-path>|show");
    } else if (command === "meetings") {
      if (!runtime.meetings) throw new Error("meetings command is not available in this profile");
      const sub = args[1];
      if (sub === "shadow") {
        if (!args[2]) throw new Error("Usage: henry meetings shadow <audio-file> [--title t]");
        print(await runtime.meetings.process(args[2], option("--title")));
      } else throw new Error("Usage: henry meetings shadow <audio-file> [--title t]");
    } else if (command === "screenshots") {
      if (!runtime.screenshots) throw new Error("screenshots command is not available in this profile");
      const sub = args[1] || "backlog";
      if (sub === "backlog") print(await runtime.screenshots.sortBacklog(Number(option("--limit")) || 20));
      else if (sub === "sort") { if (!args[2]) throw new Error("Usage: henry screenshots sort <image-path>"); print(await runtime.screenshots.sortOne(args[2])); }
      else if (sub === "watch") { const close = await runtime.screenshots.watch(); keepAlive = true; console.log("Watching for screenshots. Ctrl+C to stop."); process.once("SIGINT", () => { close(); process.exit(0); }); }
      else throw new Error("Usage: henry screenshots backlog|sort <path>|watch");
    } else if (command === "catalogue" || command === "quote" || command === "sheets") {
      if (!runtime.commerce) throw new Error(`${command} is not enabled. Set HENRY_COMMERCE_ENABLED=true or use Kelly.`);
      print(await runCommerceCommand(runtime.commerce, command, args.slice(1)));
    } else if (command === "designs") {
      print(await runDesignsCommand(runtime.designs, args.slice(1)));
    } else if (command === "knowledge") {
      const { KnowledgeBase } = await import("./knowledge/store.ts");
      const kb = new KnowledgeBase(runtime.config);
      try {
        const sub = args[1] || "stats";
        if (sub === "export") {
          const { exportOrgKnowledge } = await import("./knowledge/adapters/org-mongo.ts");
          print(await exportOrgKnowledge(path.join(runtime.config.knowledgeDir, "raw")));
        } else if (sub === "index") {
          const { KnowledgeIngestor } = await import("./knowledge/ingest.ts");
          print(await new KnowledgeIngestor(runtime.config, runtime.activity, kb, runtime.agent.providerRunner).ingestRaw({ limit: Number(option("--limit")) || undefined }));
        } else if (sub === "distill") {
          const { KnowledgeIngestor } = await import("./knowledge/ingest.ts");
          print(await new KnowledgeIngestor(runtime.config, runtime.activity, kb, runtime.agent.providerRunner).ingestCards({ limit: Number(option("--limit")) || 3 }));
        } else if (sub === "add") {
          const target = args[2];
          if (!target) throw new Error("Usage: henry knowledge add <path> [--domain gtm|growth-strategy|product-management|project-management|software-development|community|sales|careers|general] [--name <batch-name>] [--distill]");
          const { importKnowledge } = await import("./knowledge/importer.ts");
          const { KNOWLEDGE_DOMAINS } = await import("./knowledge/store.ts");
          const domainArg = option("--domain");
          if (domainArg && !KNOWLEDGE_DOMAINS.includes(domainArg as (typeof KNOWLEDGE_DOMAINS)[number])) {
            throw new Error(`Unknown domain "${domainArg}". Choose one of: ${KNOWLEDGE_DOMAINS.join(", ")}`);
          }
          const distill = args.includes("--distill");
          const report = await importKnowledge(runtime.config, kb, [target], {
            domain: domainArg as (typeof KNOWLEDGE_DOMAINS)[number] | undefined,
            sourceName: option("--name"),
            distill,
            runner: distill ? runtime.agent.providerRunner : undefined,
          });
          print(report);
          console.log(distill
            ? "\n--distill spent provider calls to generate strategy cards."
            : "\nRaw indexing above used local embeddings only (free). Pass --distill to also generate strategy cards — that spends provider calls.");
        } else if (sub === "search") {
          const query = args.slice(2).filter((item) => !item.startsWith("--") && item !== option("--domain")).join(" ");
          if (!query) throw new Error("Usage: henry knowledge search <query> [--domain gtm]");
          print((await kb.recall(query, { domain: option("--domain") })).map((r) => ({ score: r.score, source: r.source, content: r.content.slice(0, 200) })));
        } else if (sub === "context") {
          print(await kb.context(args.slice(2).join(" "), { domain: option("--domain") }));
        } else if (sub === "eval") {
          const { runKnowledgeEval, formatEvalReport } = await import("./metrics/eval.ts");
          const report = await runKnowledgeEval(runtime.config, kb);
          console.log(formatEvalReport(report));
          console.log(`\nWrote ${path.join(path.dirname(runtime.config.evalPath), "last-run.json")}`);
        } else if (sub === "stats") {
          print(kb.stats());
        } else throw new Error("Usage: henry knowledge export|index|distill|add|search|context|eval|stats");
      } finally { kb.close(); }
    } else if (command === "dispatch") {
      const role = args[1] || "architect";
      const task = args.slice(2).filter((item) => item !== "--edit").join(" ");
      if (!task) throw new Error("Usage: henry dispatch <role> <task>");
      print((await runtime.luna.dispatch(role, task, { allowEdits: args.includes("--edit") })).response);
    } else if (command === "gmail") {
      await runGmailCommand(runtime, args[1] || "inbox");
    } else if (command === "draft") {
      const sub = args[1] || "replies";
      if (sub === "replies" || sub === "reply") await runGmailCommand(runtime, "draftreplies");
      else if (sub === "mail" || sub === "email") await runGmailCommand(runtime, "draft");
      else throw new Error("Usage: henry draft replies [--limit 5] | henry draft mail --to email --subject subject --body body");
    } else if (command === "pr") {
      const sub = args[1] || "review";
      const target = args[2];
      if (!target) throw new Error("Usage: henry pr review|merge <pr-number-or-url> [--cwd path] [--repo owner/name]");
      const cwdArg = option("--cwd");
      const repoArg = option("--repo");
      const cwd = cwdArg || (repoArg?.startsWith("/") ? repoArg : runtime.config.rootDir);
      const repo = repoArg?.startsWith("/") ? undefined : repoArg;
      if (sub === "review") print(await runtime.reviewer.review(target, path.resolve(cwd), repo));
      else if (sub === "merge") {
        const result = await runtime.reviewer.prepareMerge(
          target, path.resolve(cwd), repo, option("--check") || "npm test", option("--verify") || option("--check") || "npm test",
          (option("--method") || "squash") as "merge" | "squash" | "rebase",
        );
        print({ ...result, next: `Review the plan, then: henry approve approve ${result.approvalId} && henry approve send ${result.approvalId}` });
      } else throw new Error("Usage: henry pr review|merge <pr-number-or-url> [--cwd path] [--repo owner/name]");
    } else if (command === "review") {
      const target = args[1];
      if (!target) throw new Error("Usage: henry review <pr-number-or-url> [--cwd path] [--repo owner/name]");
      const cwd = option("--cwd") || (option("--repo")?.startsWith("/") ? option("--repo") : runtime.config.rootDir) || runtime.config.rootDir;
      const repo = option("--repo")?.startsWith("/") ? undefined : option("--repo");
      print(await runtime.reviewer.review(target, path.resolve(cwd), repo));
    } else if (command === "approve") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.approvals.list());
      else if (sub === "approve") { if (!args[2]) throw new Error("Usage: henry approve approve <id>"); await runtime.approve(args[2]); console.log(`Approved ${args[2]}`); }
      else if (sub === "send" || sub === "execute") {
        if (!args[2]) throw new Error("Usage: henry approve send <id>");
        const item = await runtime.approvals.get(args[2]);
        if (!item) throw new Error("Approval not found");
        if (item.status !== "approved") {
          throw new Error(
            `Sending is blocked: approval ${args[2]} is ${item.status}. Run 'henry approve approve ${args[2]}' first; sending never approves implicitly.`,
          );
        }
        print(await runtime.executeApproval(args[2]));
      }
      else throw new Error("Usage: henry approve list|approve|send <id>");
    } else if (command === "schedule") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.scheduler.definitions());
      else if (sub === "run") { const id = args[2]; const definition = (await runtime.scheduler.definitions()).find((item) => item.id === id); if (!definition) throw new Error(`Workflow not found: ${id}`); print(await runtime.scheduler.run(definition)); }
      else if (sub === "daemon") {
        // One daemon serves both engines: legacy JSON kinds and markdown workflows.
        await runtime.scheduler.start();
        const armed = await runtime.workflowEngine.start();
        keepAlive = true;
        announceTelegramPump(runtime.startTelegramPump());
        console.log(`Henry scheduler is running (${armed.length} markdown workflow schedules armed). Press Ctrl+C to stop.`);
      }
      else if (sub === "install") {
        const definitions = await runtime.scheduler.definitions();
        const wantsCron = args.includes("--cron");
        const wantsLaunchd = args.includes("--launchd");
        const dryRun = args.includes("--print") || args.includes("--dry-run") || (!wantsCron && !wantsLaunchd);
        if (dryRun) {
          print({
            cron: await writeCronFile(runtime.config, definitions),
            launchd: await writeLaunchdPlist(runtime.config, definitions),
            note: "Review the generated files, then run `henry schedule install --cron` and/or `henry schedule install --launchd` to actually install them.",
          });
        } else {
          const result: Record<string, unknown> = {};
          if (wantsCron) result.cron = await installCron(runtime.config, definitions);
          if (wantsLaunchd) result.launchd = await installLaunchd(runtime.config, definitions);
          print(result);
        }
      }
      else if (sub === "uninstall") {
        const wantsCron = args.includes("--cron");
        const wantsLaunchd = args.includes("--launchd");
        const result: Record<string, unknown> = {};
        if (wantsCron || !wantsLaunchd) result.cron = await uninstallCron(runtime.config);
        if (wantsLaunchd || !wantsCron) result.launchd = await uninstallLaunchd(runtime.config);
        print(result);
      }
      else if (sub === "status") print(await schedulerStatus(runtime.config));
      else throw new Error("Usage: henry schedule list|run <id>|daemon|install [--cron] [--launchd] [--print]|uninstall [--cron] [--launchd]|status");
    } else if (command === "workflow") {
      const sub = args[1] || "list";
      if (sub === "list") {
        const workflows = await runtime.workflowEngine.load();
        print(workflows.map((workflow) => ({
          name: workflow.name,
          enabled: workflow.enabled,
          description: workflow.description,
          triggers: workflow.triggers.map((trigger) => trigger.type === "schedule" ? `schedule ${trigger.cron}${trigger.timezone ? ` ${trigger.timezone}` : ""}` : `command ${trigger.command}`),
          output: workflow.outputs.find((output) => output.type === "docs")?.path,
        })));
        const problems = runtime.workflowEngine.registry.problems();
        if (Object.keys(problems).length) print({ invalid: problems });
      } else if (sub === "show") {
        if (!args[2]) throw new Error("Usage: henry workflow show <name>");
        await runtime.workflowEngine.load();
        const workflow = runtime.workflowEngine.get(args[2]);
        if (!workflow) throw new Error(`Workflow not found: ${args[2]}`);
        print(workflow);
      } else if (sub === "run") {
        if (!args[2]) throw new Error("Usage: henry workflow run <name>");
        print(await runtime.workflowEngine.run(args[2], "cli"));
      } else if (sub === "logs") {
        if (!args[2]) throw new Error("Usage: henry workflow logs <name>");
        const artifacts = await runtime.workflowEngine.artifacts(args[2]);
        print({ workflow: args[2], runs: artifacts });
        if (artifacts[0]) { console.log(`\n--- ${artifacts[0]} ---\n`); console.log(await fs.readFile(artifacts[0], "utf8")); }
      } else if (sub === "daemon") {
        const armed = await runtime.workflowEngine.start();
        keepAlive = true;
        print({ armed });
        console.log("Henry workflow engine is running. Press Ctrl+C to stop.");
      } else throw new Error("Usage: henry workflow list|show <name>|run <name>|logs <name>|daemon");
    } else if (command === "goal") {
      const description = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!description) throw new Error("Usage: henry goal <description...>");
      const { filePath, raw } = await runtime.goals.intake(description);
      console.log(raw);
      console.log(`\nSaved plan: ${filePath}`);
      console.log("Taylor reviews this plan, then uses `henry code`/`henry dispatch` (or asks Henry to proceed) — nothing here was auto-executed.");
    } else if (command === "remind") {
      const sub = args[1];
      if (sub === "list") {
        print((await runtime.reminders.list()).map((item) => ({
          id: item.id, text: item.text, kind: item.kind, dueAt: item.dueAt, cron: item.cron,
          randomDaily: item.randomDaily, nextFireAt: item.nextFireAt, approvalId: item.approvalId, status: item.status,
        })));
      } else if (sub === "cancel") {
        if (!args[2]) throw new Error("Usage: henry remind cancel <id>");
        print(await runtime.reminders.cancel(args[2]));
      } else {
        const executeApprovalId = option("--execute-approval");
        const at = option("--at");
        const inValue = option("--in");
        const every = option("--every");
        const randomDailyValue = option("--random-daily");
        if (executeApprovalId) {
          if (every) throw new Error("henry remind --execute-approval does not support --every — a scheduled send is one-shot, never recurring.");
          if (!at && !inValue) throw new Error('Usage: henry remind --execute-approval <approvalId> --at "YYYY-MM-DD HH:mm" | --in "2h"');
          const dueAt = at ? parseAt(at) : parseIn(inValue!);
          const reminder = await runtime.reminders.createApprovalExecute(executeApprovalId, dueAt, option("--title"));
          print({ id: reminder.id, text: reminder.text, kind: reminder.kind, approvalId: reminder.approvalId, dueAt: reminder.dueAt, status: reminder.status });
        } else {
          const promptText = option("--prompt");
          const text = promptText || (sub && !sub.startsWith("--") ? sub : undefined);
          const kind: ReminderKind = promptText ? "prompt" : "message";
          const usage = 'Usage: henry remind "<text>" --at "YYYY-MM-DD HH:mm" | --in "2h" | --every "<cron>" | --random-daily 5  (or: henry remind --prompt "<instruction>" --at|--in|--every|--random-daily ...)';
          if (!text || (!at && !inValue && !every && !randomDailyValue)) throw new Error(usage);
          if (randomDailyValue && (at || inValue || every)) throw new Error("--random-daily cannot be combined with --at, --in, or --every");
          const randomCount = randomDailyValue ? Number(randomDailyValue) : undefined;
          if (randomDailyValue && (randomCount === undefined || !Number.isInteger(randomCount) || randomCount < 1)) throw new Error("--random-daily requires a positive integer count");
          const reminder = randomDailyValue
            ? await runtime.reminders.createRandomDaily(text, randomCount, kind)
            : every
              ? await runtime.reminders.createRecurring(text, every, kind)
              : await runtime.reminders.create(text, at ? parseAt(at) : parseIn(inValue!), kind);
          print({ id: reminder.id, text: reminder.text, kind: reminder.kind, dueAt: reminder.dueAt, cron: reminder.cron, nextFireAt: reminder.nextFireAt, status: reminder.status });
        }
      }
    } else if (command === "telegram") {
      const sub = args[1] || "test";
      if (sub === "test") {
        const ok = await sendTelegram(runtime.config, "Henry → Telegram is live 🎉");
        console.log(ok ? "ok — check your Telegram chat" : "fail — check HENRY_TELEGRAM_BOT_TOKEN / HENRY_TELEGRAM_CHAT_ID in .env, then see docs/modules/telegram.md");
      } else if (sub === "status") {
        const bridge = runtime.telegramBridge;
        print({
          botToken: Boolean(runtime.config.telegramBotToken),
          dmChatConfigured: Boolean(runtime.config.telegramChatId),
          standupChatConfigured: Boolean(runtime.config.telegramStandupChatId),
          bridge: { enabled: bridge.enabled, killSwitch: "telegram.bridge.enabled in data/settings.json", ...bridge.stats() },
          operatorMode: runtime.config.telegramOperatorMode,
          note: "One getUpdates pump serves both; it runs inside `henry repl` or `henry schedule daemon`.",
        });
      } else if (sub === "on" || sub === "off") {
        const { updateSettings } = await import("./util/settings.ts");
        updateSettings(runtime.config.settingsPath, { telegram: { bridge: { enabled: sub === "on" } } });
        console.log(`Telegram DM bridge ${sub === "on" ? "ON" : "OFF"}.`);
      } else if (sub === "operator") {
        const mode = args[2];
        if (mode !== "on" && mode !== "off") throw new Error("Usage: henry telegram operator on|off");
        await runtime.setTelegramOperatorMode(mode === "on");
        console.log(`Telegram operator mode ${mode === "on" ? "ON" : "OFF"}. Restart the long-lived Henry process to apply it to its bridge.`);
      } else throw new Error("Usage: henry telegram test|status|on|off|operator on|off");
    } else if (command === "mailwatch") {
      if (!runtime.mailwatch) throw new Error("mailwatch command is not available in this profile");
      const sub = args[1] || "check";
      if (sub === "check") print(await runtime.mailwatch.check());
      else if (sub === "status") print(await runtime.mailwatch.status());
      else if (sub === "tracker") {
        const summary = await trackerSummary(runtime.config);
        console.log(`Job tracker: ${summary.markdownPath} (${summary.total} application${summary.total === 1 ? "" : "s"})`);
        print(summary);
      } else if (sub === "backfill") {
        const days = Number(option("--days")) || 30;
        print(await runtime.mailwatch.backfill(days));
      } else if (sub === "digest") {
        const { trackerDigest } = await import("./mailwatch/tracker.ts");
        const digest = await trackerDigest(runtime.config);
        console.log(digest.line);
        if (args.includes("--send")) await runtime.notifyOperator(digest.line, "Henry — job index");
      } else throw new Error("Usage: henry mailwatch check|status|tracker|backfill --days <n>|digest [--send]");
    } else if (command === "pm") {
      const sub = args[1] || "status";
      if (sub === "on") { await runtime.setPmMode(true); console.log("PM mode ON — Henry now operates as your project manager (PMBOK-grounded, decisions with rationale). `henry pm off` to exit."); }
      else if (sub === "off") { await runtime.setPmMode(false); console.log("PM mode OFF."); }
      else if (sub === "status") console.log(`PM mode: ${runtime.config.pmMode ? "ON" : "off"}`);
      else throw new Error("Usage: henry pm on|off|status");
    } else if (command === "standup") {
      if (isServiceExcluded("standup")) throw new Error("standup command is not available in this profile");
      const sub = args[1] || "status";
      const date = option("--date");
      const sessionOption = option("--session") || "morning";
      if (sessionOption !== "morning" && sessionOption !== "evening") throw new Error("--session must be morning or evening");
      const session = sessionOption as "morning" | "evening";
      if (sub === "status") print(runtime.standup.status(date));
      else if (sub === "discover") {
        const chats = await runtime.standupPoller.discoverChats();
        if (chats.length === 0) console.log("No pending updates seen. Add your configured bot to the group, have someone post one message, then rerun.");
        else {
          print(chats);
          console.log("\nPut the group's id into .env as HENRY_TELEGRAM_STANDUP_CHAT_ID (group ids are negative), then restart Henry.");
        }
      } else if (sub === "prompt") print(await runtime.standup.promptDay(date, session));
      else if (sub === "scan") {
        print(await runtime.standupPoller.pollOnce());
        print(await runtime.standup.scan(date));
      } else if (sub === "summary") {
        await runtime.standupPoller.pollOnce();
        await runtime.standup.scan(date);
        const result = await runtime.standup.summarize(date, { post: args.includes("--post"), session });
        if (result.markdown) { console.log(`\n${result.markdown}\n`); console.log(`Saved: ${result.filePath}`); }
        else console.log(`No ${result.session} updates collected for ${result.date}.${result.missing.length ? ` Missing: ${result.missing.join(", ")}` : ""}`);
      } else throw new Error("Usage: henry standup status|discover|prompt|scan|summary [--date YYYY-MM-DD] [--session morning|evening] [--post]");
    } else if (command === "linkedin") {
      if (!runtime.linkedin) throw new Error("linkedin command is not available in this profile");
      const topic = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!topic) throw new Error("Usage: henry linkedin <topic...>");
      const result = await runtime.linkedin.draft(topic);
      console.log(result.draft);
      console.log(`\nDraft saved — review and post manually: ${result.markdownPath}`);
    } else if (command === "tweet") {
      if (isServiceExcluded("social")) throw new Error("tweet command is not available in this profile");
      // The daily tech tweet — soul.md's single standing outbound exception. `draft` never
      // posts; a bare `tweet` respects the once-per-day ledger and the kill switch, and
      // stages (with a Telegram note) whenever posting is not authorized.
      const sub = args[1];
      const { TweetService, tweetsEnabled, readXCredentials } = await import("./social/tweets.ts");
      const { updateSettings } = await import("./util/settings.ts");
      if (sub === "browser") {
        if (!runtime.xBrowser) throw new Error("tweet browser is not available in this profile");
        const action = args[2];
        if (action === "stage") {
          const directText = option("--text");
          const result = directText
            ? await runtime.xBrowser.stageText(directText)
            : await runtime.xBrowser.stage(option("--date"));
          print({ ...result, next: `Review, then: henry approve approve ${result.approvalId} && henry approve send ${result.approvalId}` });
        } else if (action === "login") {
          if (!process.stdin.isTTY) throw new Error("X login is interactive — run `npx tsx src/cli.ts tweet browser login` in your own terminal, sign in, then press Ctrl-C.");
          await runtime.xBrowser.login();
        } else throw new Error("Usage: henry tweet browser login|stage [--date YYYY-MM-DD] [--text \"exact tweet\"]");
      } else if (sub === "on" || sub === "off") {
        updateSettings(runtime.config.settingsPath, { social: { tweets: { enabled: sub === "on" } } });
        console.log(`Daily tech tweet: ${sub === "on" ? "ENABLED" : "OFF"}${sub === "on" && !readXCredentials() ? " (but the four X_* keys are missing — runs will stage, not post)" : ""}`);
      } else if (sub === "status") {
        print({ enabled: tweetsEnabled(runtime.config.settingsPath), keysPresent: Boolean(readXCredentials()), window: "13:00-17:00 local, one random minute" });
      } else if (sub === undefined || sub === "draft") {
        const service = new TweetService(runtime.config, runtime.activity, runtime.agent.providerRunner, runtime.notifyOperator, runtime.memory);
        const result = await service.run({ trigger: "cli", stageOnly: sub === "draft" });
        if (result.text) console.log(`\n${result.text}\n`);
        if (result.posted) console.log(`Posted: https://x.com/i/status/${result.tweetId}`);
        else if (result.stagedPath) console.log(`Staged (not posted — ${result.reason}): ${result.stagedPath}`);
        else console.log(`Skipped: ${result.reason}`);
      } else throw new Error("Usage: henry tweet [draft|on|off|status|browser login|stage]  (bare `tweet` runs today's pipeline; `draft` never posts)");
    } else if (command === "launch") {
      if (!runtime.launch) throw new Error("launch command is not available in this profile");
      const sub = args[1];
      if (sub === "intake") {
        const input = args.slice(2).filter((item) => !item.startsWith("--")).join(" ");
        if (!input) throw new Error('Usage: henry launch intake "<product brief or repo path>"');
        const result = await runtime.launch.intake(input);
        console.log(result.markdown);
        console.log(`\nSaved: ${result.filePath}`);
        console.log(`Taylor: fill in each ANSWER: line above, save the file, then run: henry launch run ${result.slug}`);
      } else if (sub === "run") {
        if (!args[2]) throw new Error("Usage: henry launch run <slug>");
        const result = await runtime.launch.run(args[2]);
        console.log(result.dossier);
        console.log(`\nSaved: ${result.filePath}`);
      } else if (sub === "list") {
        print(await runtime.launch.list());
      } else throw new Error('Usage: henry launch intake "<brief|path>" | run <slug> | list');
    } else throw new Error("Commands: ask, repl, dashboard, status, tunnel, users, code, provider, jobs, cover, resume, jd, memory, dispatch, gmail, review, approve, schedule, workflow, goal, remind, telegram, mailwatch, standup, linkedin, tweet, launch");
  } finally {
    if (!keepAlive) runtime.close();
  }
}

async function runVoiceCommand(voiceArgs: string[]): Promise<void> {
  const usage = "Usage: kelly voice status | serve | transcribe <wav> --language auto|hi|en | speak <text> --language hi|en --out <new.wav>";
  const sub = voiceArgs[0];
  const optionValue = (name: string): string | undefined => {
    const index = voiceArgs.indexOf(name);
    return index < 0 ? undefined : voiceArgs[index + 1];
  };
  if (sub === "serve") {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const model = process.env.KELLY_KOKORO_MODEL_PATH;
    const voices = process.env.KELLY_KOKORO_VOICES_PATH;
    const token = process.env.KELLY_KOKORO_TOKEN || "";
    if (!model || !voices) throw new Error("Set KELLY_KOKORO_MODEL_PATH and KELLY_KOKORO_VOICES_PATH to existing local files; Kelly does not download model weights");
    if (token.length < 24) throw new Error("KELLY_KOKORO_TOKEN must contain at least 24 characters");
    const modelPath = path.resolve(repoRoot, model);
    const voicesPath = path.resolve(repoRoot, voices);
    for (const [label, filePath] of [["Kokoro model", modelPath], ["Kokoro voices", voicesPath]] as const) {
      const info = await fs.stat(filePath).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`${label} file does not exist: ${filePath}`);
    }
    const python = process.env.KELLY_VOICE_PYTHON || path.join(repoRoot, "data/voice/venv/bin/python");
    const pythonPath = path.isAbsolute(python) ? python : path.resolve(repoRoot, python);
    let workerUrl: URL;
    try { workerUrl = new URL(process.env.KELLY_KOKORO_URL || "http://127.0.0.1:8765"); }
    catch { throw new Error("KELLY_KOKORO_URL must be a loopback HTTP origin, for example http://127.0.0.1:8765"); }
    if (workerUrl.protocol !== "http:" || workerUrl.username || workerUrl.password
      || !["127.0.0.1", "localhost", "[::1]"].includes(workerUrl.hostname.toLowerCase())
      || workerUrl.pathname !== "/" || workerUrl.search || workerUrl.hash) {
      throw new Error("KELLY_KOKORO_URL must be a loopback HTTP origin, for example http://127.0.0.1:8765");
    }
    const port = Number(workerUrl.port || 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("KELLY_KOKORO_URL must include a valid port");
    const script = path.join(repoRoot, "scripts/voice/kokoro_server.py");
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pythonPath, [script, "--model", modelPath, "--voices", voicesPath, "--port", String(port)], {
        shell: false,
        stdio: "inherit",
        env: { ...process.env, KELLY_KOKORO_TOKEN: token },
      });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Kokoro worker exited ${code === null ? "after a signal" : `with code ${code}`}`)));
    });
    return;
  }
  const { LocalVoiceService, voiceConfigFromEnv } = await import("./voice/index.ts");
  const config = voiceConfigFromEnv();
  const voice = new LocalVoiceService(config);

  if (sub === "status") {
    let kokoro = config.tts?.engine === "kokoro" && voice.ttsEnabled() ? "configured" : "not configured";
    if (kokoro === "configured" && config.tts?.url && config.tts.token) {
      try {
        const health = new URL("/health", config.tts.url);
        const response = await fetch(health, {
          headers: { Authorization: `Bearer ${config.tts.token}` },
          signal: AbortSignal.timeout(2_000),
        });
        kokoro = response.ok ? "ready" : `unavailable (HTTP ${response.status})`;
      } catch { kokoro = "unavailable (worker not reachable)"; }
    }
    print({ transcription: voice.sttEnabled() ? "configured" : "not configured", speech: kokoro });
    return;
  }

  if (sub === "transcribe") {
    const wavPath = voiceArgs[1];
    const language = optionValue("--language");
    if (!wavPath || wavPath.startsWith("--") || !language || !["auto", "hi", "en"].includes(language)) throw new Error(usage);
    const audio = await fs.readFile(path.resolve(wavPath));
    const result = await voice.transcribe(audio, { language });
    print(result.text);
    return;
  }

  if (sub === "speak") {
    const language = optionValue("--language");
    const outPath = optionValue("--out");
    if (!language || !["hi", "en"].includes(language) || !outPath || outPath.startsWith("--")) throw new Error(usage);
    const textParts: string[] = [];
    for (let index = 1; index < voiceArgs.length; index += 1) {
      if (voiceArgs[index] === "--language" || voiceArgs[index] === "--out") { index += 1; continue; }
      textParts.push(voiceArgs[index]!);
    }
    const text = textParts.join(" ").trim();
    if (!text) throw new Error(usage);
    const audio = await voice.synthesize(text, { language });
    const target = path.resolve(outPath);
    const file = await fs.open(target, "wx", 0o600);
    try { await file.writeFile(audio); }
    catch (error) { await file.close(); await fs.rm(target, { force: true }); throw error; }
    await file.close();
    print({ output: target, bytes: audio.length });
    return;
  }
  throw new Error(usage);
}

// Last-line backstop (audit 2026-08-09): long-lived Henry processes (repl, daemon,
// dashboard) must survive a stray rejection from any corner — log it, keep living.
process.on("unhandledRejection", (reason) => {
  console.error(`henry: unhandled rejection (survived): ${reason instanceof Error ? reason.message : String(reason)}`);
});
main().catch((error) => { console.error(`henry: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
