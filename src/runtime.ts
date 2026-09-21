import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ActivityLog } from "./activity.ts";
import { ApprovalStore } from "./approval/store.ts";
import { HenryMemory } from "./memory/engram.ts";
import { KnowledgeBase } from "./knowledge/store.ts";
import { HenryAgent } from "./agent/henry.ts";
import { LunaOrchestrator } from "./orchestration/luna.ts";
import { GmailService } from "./integrations/gmail.ts";
import { WorkflowScheduler } from "./scheduler/scheduler.ts";
import { PullRequestReviewer } from "./pr/review.ts";
import { JobApplicationService } from "./jobs/service.ts";
import { JobScoutService } from "./jobs/scout.ts";
import { CoverLetterService } from "./jobs/cover.ts";
import { TailoredApplicationService } from "./jobs/tailor.ts";
import { MeetingShadowService } from "./meetings/service.ts";
import { ScreenshotSorterService } from "./screenshots/service.ts";
import { ResumeEditorService } from "./jobs/resume-editor.ts";
import { WorkflowEngine } from "./workflows/engine.ts";
import { GoalService } from "./goals/service.ts";
import { ReminderService, notifyReminder, type ReminderNotifier } from "./reminders/service.ts";
import { LinkedInDraftService } from "./social/linkedin.ts";
import { LaunchCrewService } from "./launch/service.ts";
import { XBrowserPostService } from "./social/x-browser.ts";
import { readSettings, updateSettings } from "./util/settings.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { MailWatchService } from "./mailwatch/service.ts";
import { StandupStore } from "./standup/store.ts";
import { StandupService } from "./standup/service.ts";
import { StandupPoller } from "./standup/poller.ts";
import { TelegramPump } from "./telegram/pump.ts";
import { sharedAgentRegistry } from "./orchestration/agent-registry.ts";
import { TelegramBridge, type BridgeVoice } from "./telegram/bridge.ts";
import { TelegramVoiceIntake, ffmpegAudioConverter, httpTelegramFileFetcher, sendTelegramVoiceNote, telegramVoiceReplier } from "./telegram/voice.ts";
import { LocalVoiceService, voiceConfigFromEnv } from "./voice/index.ts";
import { VoiceTranscriptStore } from "./voice/transcripts.ts";
import { limitState } from "./providers/limits.ts";
import { DraftRepliesService } from "./gmail-drafts/service.ts";
import type { ProviderName, RunResult } from "./types.ts";
import type { RunOptions } from "./providers/runner.ts";
import { isLongResearchAsk, type DispatchReportHandle } from "./orchestration/luna.ts";
import type { ReflexSnapshot } from "./reflex.ts";
import { isServiceExcluded, getActiveProfile } from "./profile.ts";
import { CommerceService } from "./commerce/service.ts";

export type InteractiveTurn =
  | { delegated: false; completion: Promise<RunResult> }
  | ({ delegated: true } & DispatchReportHandle);

export class HenryRuntime {
  readonly activity: ActivityLog;
  readonly approvals: ApprovalStore;
  readonly memory: HenryMemory;
  readonly agent: HenryAgent;
  readonly luna: LunaOrchestrator;
  readonly gmail?: GmailService;
  readonly scheduler: WorkflowScheduler;
  readonly reviewer: PullRequestReviewer;
  readonly jobs?: JobApplicationService;
  readonly cover?: CoverLetterService;
  readonly tailor?: TailoredApplicationService;
  readonly resumeEditor?: ResumeEditorService;
  readonly meetings?: MeetingShadowService;
  readonly screenshots?: ScreenshotSorterService;
  readonly goals: GoalService;
  readonly reminders: ReminderService;
  readonly linkedin?: LinkedInDraftService;
  readonly launch?: LaunchCrewService;
  readonly xBrowser?: XBrowserPostService;
  readonly mailwatch?: MailWatchService;
  readonly draftReplies?: DraftRepliesService;
  readonly commerce?: CommerceService;
  private _knowledge?: KnowledgeBase;
  private _workflowEngine?: WorkflowEngine;
  private _standupStore?: StandupStore;
  private _standup?: StandupService;
  private _standupPoller?: StandupPoller;
  private _telegramBridge?: TelegramBridge;
  private _telegramVoice?: TelegramVoiceIntake | null;
  private _voiceTranscripts?: VoiceTranscriptStore;
  private _telegramPump?: TelegramPump;
  private _jobScout?: JobScoutService;

  /**
   * Composed operator-notification channel: console + osascript (via `notifyReminder`) then
   * a fire-and-forget Telegram send when configured. This is the one place reminders and
   * mail-watch alerts are wired together with Telegram — neither module imports the other or
   * imports `notify/telegram.ts` itself (doctrine rule 7); the runtime composition root does.
   */
  readonly notifyOperator: ReminderNotifier = async (message, title) => {
    await notifyReminder(message, title);
    // Telegram is fail-open by design, but the FAILURE must still be visible in the
    // logs page — "why didn't my phone buzz" was undebuggable while this was silent.
    void sendTelegram(this.config, title && title !== "Henry" ? `${title}: ${message}` : message)
      .then((ok) => { if (!ok && this.config.telegramBotToken) void this.activity.record("workflow.failed", "Telegram delivery failed (fail-open)", { telegram: true, title: title ?? "Henry" }); })
      .catch(() => undefined);
  };

  private constructor(readonly config: HenryConfig) {
    this.activity = new ActivityLog(config.activityPath);
    this.approvals = new ApprovalStore(config.approvalsPath);
    this.memory = new HenryMemory(config, this.activity);
    if (config.commerceEnabled) this.commerce = new CommerceService(config, this.activity);

    this.agent = new HenryAgent(config, this.activity, this.memory, () => this.knowledge);

    // Conditionally initialize excluded services. Gmail runs through the provider's
    // connector, so it is built once the agent's provider runner exists.
    if (!isServiceExcluded("gmail")) {
      this.gmail = new GmailService(this.activity, this.approvals, this.agent.providerRunner);
    }
    this.luna = new LunaOrchestrator(config, this.activity, this.memory);
    this.reminders = new ReminderService(config, this.activity);
    this.scheduler = new WorkflowScheduler(
      config, this.activity, this.memory, this.gmail, this.reminders,
      this.notifyOperator,
      (prompt) => this.agent.run(prompt).then((result) => result.response),
      (approvalId) => this.executeApproval(approvalId),
    );

    if (!isServiceExcluded("mailwatch")) {
      this.mailwatch = new MailWatchService(config, this.activity, this.agent.providerRunner, this.notifyOperator, this.memory);
    }

    if (!isServiceExcluded("draftReplies") && this.gmail) {
      const gmail = this.gmail; // Capture in closure so arrow functions can access it
      this.draftReplies = new DraftRepliesService(config, this.activity, this.agent.providerRunner, this.notifyOperator, {
        readSources: (limit) => gmail.inbox(limit),
        stage: (input) => gmail.queueEmail(input),
      });
    }

    this.reviewer = new PullRequestReviewer(config, this.activity, this.approvals, this.agent.providerRunner);

    if (!isServiceExcluded("jobs")) {
      this.jobs = new JobApplicationService(config, this.activity, this.approvals, this.memory, this.agent.providerRunner);
    }

    if (!isServiceExcluded("cover") && this.jobs) {
      this.cover = new CoverLetterService(config, this.activity, this.memory, this.agent.providerRunner, this.jobs);
    }

    if (!isServiceExcluded("tailor") && this.cover) {
      this.tailor = new TailoredApplicationService(config, this.activity, this.agent.providerRunner, this.cover, this.memory);
    }

    if (!isServiceExcluded("resumeEditor")) {
      this.resumeEditor = new ResumeEditorService(config, this.activity, this.memory, this.agent.providerRunner);
    }

    if (!isServiceExcluded("meetings")) {
      this.meetings = new MeetingShadowService(config, this.activity, this.memory, this.agent.providerRunner);
    }

    if (!isServiceExcluded("screenshots")) {
      this.screenshots = new ScreenshotSorterService(config, this.activity, this.agent.providerRunner);
    }

    this.goals = new GoalService(config, this.activity, this.memory, this.luna);

    if (!isServiceExcluded("linkedin")) {
      this.linkedin = new LinkedInDraftService(config, this.activity, this.memory, this.agent.providerRunner);
    }

    if (!isServiceExcluded("launch")) {
      this.launch = new LaunchCrewService(config, this.activity, this.memory, () => this.knowledge, this.agent.providerRunner);
    }

    if (!isServiceExcluded("xBrowser")) {
      this.xBrowser = new XBrowserPostService(config, this.activity, this.approvals);
    }
  }

  /** Lazily opens the organization's knowledge DB on first domain-relevant turn; keeps boot fast. */
  get knowledge(): KnowledgeBase {
    if (!this._knowledge) this._knowledge = new KnowledgeBase(this.config);
    return this._knowledge;
  }

  /**
   * Markdown workflow engine (`workflows/*.workflow.md`). Constructed on first use and
   * inert until `start()` — only the workflow/schedule daemons watch files and arm crons.
   */
  get workflowEngine(): WorkflowEngine {
    if (!this._workflowEngine) this._workflowEngine = new WorkflowEngine(this.config, this.activity, this.agent.providerRunner);
    return this._workflowEngine;
  }

  private get standupStore(): StandupStore {
    if (!this._standupStore) this._standupStore = new StandupStore(this.config);
    return this._standupStore;
  }

  /** Lazily opens data/standups.db on first standup-relevant call; inert until the Telegram group is configured. */
  get standup(): StandupService {
    if (isServiceExcluded("standup")) {
      throw new Error("standup service is not available in this profile");
    }
    if (!this._standup) {
      this._standup = new StandupService(this.config, this.activity, this.agent.providerRunner, this.standupStore, this.notifyOperator, this.memory);
    }
    return this._standup;
  }

  get standupPoller(): StandupPoller {
    if (isServiceExcluded("standupPoller")) {
      throw new Error("standupPoller service is not available in this profile");
    }
    if (!this._standupPoller) this._standupPoller = new StandupPoller(this.config, this.activity, this.standupStore);
    return this._standupPoller;
  }

  /**
   * Luvish's two-way DM. The composition root is the ONLY place the bridge meets the two
   * things it deliberately does not own: the brain (`agent.run`, same entry as the dashboard
   * chat — its own tiers, memory, and sessions apply) and the sender (`sendTelegram`, already
   * pinned to Luvish's chat, so no new outbound surface exists). readOnly is the rail: the
   * bridge is a conversation, and repo mutations stay in the terminal session.
   */
  get telegramBridge(): TelegramBridge {
    if (!this._telegramBridge) {
      this._telegramBridge = new TelegramBridge(this.config, this.activity, this.standupStore, {
        think: (prompt, reportToTelegram) => {
          const turn = this.startInteractiveTurn(prompt, {
            surface: "telegram",
            readOnly: !this.config.telegramOperatorMode,
            role: this.config.telegramOperatorMode ? "telegram-operator" : "telegram-bridge",
          });
          if (!turn.delegated) {
            return turn.completion.then((result) => {
              // Out of quota is NOT an answer. Surfaced as an ordinary empty response it made
              // the bridge fall through to "say it again" and discard the turn; `deferrable`
              // lets the bridge keep the message and resume it when capacity returns.
              if (result.limited) throw Object.assign(new Error(result.error ?? "every provider is out of quota"), { deferrable: true });
              return result.response;
            });
          }
          // The bridge sends this acknowledgement through its normal reply path.
          // The finished report is a second DM, so the inbound queue is free for
          // Luvish's next message while the research worker is still running.
          void turn.completion.then(async (result) => {
            // Out of quota is not a failed research turn — it is unanswered work, so the
            // owner is told to ask again later instead of being told "Research failed".
            const report = result.limited
              ? this.limitedResearchReply(result.error)
              : result.exitCode === 0 && result.response.trim()
                ? result.response.trim()
                : `Research failed: ${result.error ?? `Codex exited ${String(result.exitCode)}`}`;
            const sent = await reportToTelegram(report);
            // A failure recording the OUTCOME must never look like the report itself
            // failed — the DM has already gone out (or been attempted) by this point,
            // so this failure is swallowed rather than reaching the catch below.
            await this.activity.record(sent ? "run.completed" : "run.failed", sent ? "Telegram delivered Luna's research report" : "Telegram could not deliver Luna's research report", {
              telegram: true, dispatchReport: true, chars: report.length,
            }, { runId: result.runId, role: "research", provider: result.provider }).catch((error) => { console.warn("Luna research activity record failed", error); });
          }).catch(async (error) => {
            const message = `Research failed: ${error instanceof Error ? error.message : String(error)}`;
            await reportToTelegram(message).catch(() => false);
            await this.activity.record("run.failed", "Luna research dispatch threw", { telegram: true, dispatchReport: true, error: message }, { role: "research", provider: "codex" }).catch(() => undefined);
          });
          return Promise.resolve(turn.acknowledgement);
        },
        send: (config, text) => sendTelegram(config, text),
        // Owner voice notes. Absent when local speech recognition or the converter is not
        // configured, in which case the bridge declines them in one plain sentence.
        ...(this.telegramVoiceIntake ? { voice: this.telegramVoiceWithReplies(this.telegramVoiceIntake) } : {}),
        // Local state for the reflex lane, so "what are you working on?" is answered from
        // the dispatch registry and the approval queue instead of costing a provider run
        // and waiting behind whatever turn is already in flight.
        snapshot: () => this.reflexSnapshot(),
      });
    }
    return this._telegramBridge;
  }

  /**
   * What Kelly heard, kept on the owner's terms (see voice/transcripts.ts). Lazy: the
   * database is opened the first time a surface transcribes or the dashboard asks.
   */
  get voiceTranscripts(): VoiceTranscriptStore {
    this._voiceTranscripts ||= new VoiceTranscriptStore(this.config.dataDir, this.config.settingsPath);
    return this._voiceTranscripts;
  }

  /**
   * Owner voice-note intake, or undefined when it cannot work.
   *
   * Everything is explicit and local: whisper.cpp through the existing voice adapter, an
   * operator-named `ffmpeg` for the OGG/Opus that Telegram sends, and Telegram's own file
   * API. Nothing is downloaded or installed here, and a missing piece disables the surface
   * rather than half-enabling it. Settings are read from the environment because voice is
   * not (yet) part of HenryConfig:
   *
   *   KELLY_TELEGRAM_VOICE=0            turn the surface off even when the rest is present
   *   KELLY_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg   required: the audio converter
   *   KELLY_TELEGRAM_VOICE_MAX_BYTES    default 20 MB
   *   KELLY_TELEGRAM_VOICE_MAX_SECONDS  default 300
   *   KELLY_TELEGRAM_VOICE_LANGUAGE     default "auto" (Hindi, English and Hinglish all arrive here)
   */
  private get telegramVoiceIntake(): TelegramVoiceIntake | undefined {
    if (this._telegramVoice === undefined) {
      this._telegramVoice = this.buildTelegramVoiceIntake() ?? null;
    }
    return this._telegramVoice ?? undefined;
  }

  private buildTelegramVoiceIntake(): TelegramVoiceIntake | undefined {
    const env = process.env;
    if (env.KELLY_TELEGRAM_VOICE === "0" || env.KELLY_TELEGRAM_VOICE === "false") return undefined;
    const token = this.config.telegramBotToken;
    const ffmpegPath = env.KELLY_FFMPEG_PATH?.trim();
    if (!token || !ffmpegPath) return undefined;
    const transcriber = new LocalVoiceService(voiceConfigFromEnv(env));
    if (!transcriber.sttEnabled()) return undefined;
    const positive = (value: string | undefined): number | undefined => {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    };
    return new TelegramVoiceIntake({
      fetcher: httpTelegramFileFetcher(token),
      converter: ffmpegAudioConverter({ executablePath: ffmpegPath }),
      transcriber,
      limits: {
        maxBytes: positive(env.KELLY_TELEGRAM_VOICE_MAX_BYTES),
        maxSeconds: positive(env.KELLY_TELEGRAM_VOICE_MAX_SECONDS),
        language: env.KELLY_TELEGRAM_VOICE_LANGUAGE?.trim() || undefined,
      },
    });
  }

  /**
   * The intake, plus a spoken reply when the operator has opted in.
   *
   * OFF by default: set KELLY_TELEGRAM_VOICE_REPLIES=1. It also needs local synthesis
   * (KELLY_KOKORO_URL and its token, or an explicit espeak-ng) and the same ffmpeg, because
   * Telegram wants Opus. Text is always sent first, so every failure here is silent and the
   * owner still has the answer. Local synthesis costs roughly real time, so only short
   * answers are spoken (see VOICE_REPLY_MAX_CHARS).
   */
  private telegramVoiceWithReplies(intake: TelegramVoiceIntake): BridgeVoice {
    // `enabled` stays a getter so the intake remains the single source of truth at call time.
    const base: BridgeVoice = {
      get enabled() { return intake.enabled; },
      transcribe: async (meta) => {
        const started = Date.now();
        try {
          const result = await intake.transcribe(meta);
          const row = this.voiceTranscripts.record({
            surface: "telegram", text: result.text, language: result.language,
            durationSeconds: result.durationSeconds, bytes: result.bytes, sttMs: Date.now() - started,
          });
          return { ...result, id: row.id };
        } catch (error) {
          // A failure keeps no words, only the fact and the reason, so the owner can see it.
          this.voiceTranscripts.record({
            surface: "telegram", text: "", state: "failed", sttMs: Date.now() - started,
            durationSeconds: meta.duration, bytes: meta.file_size,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      settle: (id, state, reply) => {
        try { this.voiceTranscripts.update(id, { state, ...(reply !== undefined ? { reply } : {}) }); } catch { /* display data; never fail a turn over it */ }
      },
    };
    const env = process.env;
    const token = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;
    if (env.KELLY_TELEGRAM_VOICE_REPLIES !== "1" || !token || !chatId || !intake.canSpeak) return base;
    const speaker = new LocalVoiceService(voiceConfigFromEnv(env));
    if (!speaker.ttsEnabled()) return base;
    return {
      ...base,
      get enabled() { return intake.enabled; },
      speak: telegramVoiceReplier({
        synthesize: (text, options) => speaker.synthesize(text, options),
        encode: (wav) => intake.encodeReply(wav),
        send: (audio) => sendTelegramVoiceNote({ token, chatId, audio }),
      }),
    };
  }

  /** Shared local-state snapshot used by every provider-free reflex surface. */
  async reflexSnapshot(): Promise<ReflexSnapshot> {
    const agents = sharedAgentRegistry().snapshot();
    return {
      running: agents.running.map((agent) => ({ role: agent.role, task: agent.task, startedAt: agent.startedAt })),
      recentDone: agents.recent.filter((agent) => agent.status === "done").length,
      pendingApprovals: (await this.approvals.list("pending")).length,
      provider: this.config.provider,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  /**
   * The DM a Telegram owner gets when a delegated research turn ran out of provider quota.
   * Plain and actionable rather than "Research failed", and carries the reset time when the
   * runner's own message (`describeLimited`, providers/limits.ts) found one.
   */
  private limitedResearchReply(error?: string): string {
    const reset = error?.match(/earliest reset ([^.]+)\./i)?.[1] ?? error?.match(/\buntil ([^.;]+)/i)?.[1];
    const resetNote = reset ? ` It resets ${reset.trim()}.` : "";
    return `Codex is out of quota right now, so I couldn't finish that research.${resetNote} Send me the ask again once quota is back.`;
  }

  /**
   * One surface-neutral entry for foreground Henry vs background Luna routing.
   * Starting a delegated turn is synchronous; its completion runs independently.
   */
  startInteractiveTurn(prompt: string, options: RunOptions = {}): InteractiveTurn {
    if (isLongResearchAsk(prompt)) {
      const handle = this.luna.dispatchAndReport(prompt, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        onEvent: options.onEvent,
        surface: options.surface,
      });
      return { delegated: true, ...handle };
    }
    return { delegated: false, completion: this.agent.run(prompt, options) };
  }

  /**
   * ONE getUpdates consumer for the whole bot token. Both inbound modules ride it: Luvish's
   * DM → the bridge, the standup group → standup's unchanged intake, anything else → counted
   * and dropped. Consumers with no chat id configured are never called.
   */
  get telegramPump(): TelegramPump {
    if (!this._telegramPump) {
      // The standup poller is a consumer only where the profile loads it. Kelly excludes it,
      // and reaching for the getter here threw, which took `kelly dashboard` down with it.
      const consumers = isServiceExcluded("standupPoller") ? [this.telegramBridge] : [this.telegramBridge, this.standupPoller];
      this._telegramPump = new TelegramPump(this.config, this.activity, this.standupStore, consumers);
    }
    return this._telegramPump;
  }

  /**
   * Morning job scout, lazily constructed — browser and scout.db only open when
   * `jobs login`/`jobs scout` actually run. `--prepare` rides the EXISTING
   * approval-gated JobApplicationService.prepare; the scout itself never submits.
   */
  get jobScout(): JobScoutService {
    if (!this._jobScout) {
      if (!this.jobs) throw new Error("jobScout requires jobs service, not available in this profile");
      this._jobScout = new JobScoutService(
        this.config, this.activity, this.agent.providerRunner, this.notifyOperator, this.memory,
        undefined,
        (url) => this.jobs!.prepare(url).then((draft) => ({ id: draft.id, approvalId: draft.approvalId })),
      );
    }
    return this._jobScout;
  }

  /**
   * Arms the ONE Telegram reader inside long-lived processes (repl / scheduler daemon).
   * Replaces the old standup-only `startStandupPoller` — same interval, same lock, same
   * offset row; it just routes to both consumers now. Safe no-op when unconfigured.
   */
  startTelegramPump(): { armed: boolean; bridge: boolean; standup: boolean } {
    const bridge = Boolean(this.telegramBridge.chatId);
    const standup = Boolean(this.config.telegramBotToken && this.config.telegramStandupChatId);
    return { armed: this.telegramPump.start(), bridge, standup };
  }

  static async create(rootDir?: string): Promise<HenryRuntime> {
    const runtime = new HenryRuntime(loadConfig(rootDir));
    await runtime.loadSettings();
    await runtime.activity.init();
    await runtime.approvals.init();
    await runtime.memory.init();
    if (!isServiceExcluded("jobs")) await runtime.jobs!.init();
    return runtime;
  }

  /** Persisted operator settings override env defaults; the dashboard toggle writes them. */
  private async loadSettings(): Promise<void> {
    try {
      const settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.provider === "codex" || settings.provider === "claude") this.config.provider = settings.provider;
      if (typeof settings.pmMode === "boolean") this.config.pmMode = settings.pmMode;
      const telegram = settings.telegram;
      if (telegram && typeof telegram === "object" && !Array.isArray(telegram)) {
        const operator = (telegram as Record<string, unknown>).operator;
        if (operator && typeof operator === "object" && !Array.isArray(operator) && typeof (operator as Record<string, unknown>).enabled === "boolean") {
          this.config.telegramOperatorMode = Boolean((operator as Record<string, unknown>).enabled);
        }
      }
    } catch { /* No settings file yet; env/default provider applies. */ }
  }

  async setTelegramOperatorMode(enabled: boolean): Promise<boolean> {
    this.config.telegramOperatorMode = enabled;
    const settings = readSettings(this.config.settingsPath);
    const telegram = settings.telegram && typeof settings.telegram === "object" && !Array.isArray(settings.telegram)
      ? settings.telegram as Record<string, unknown> : {};
    telegram.operator = { ...(telegram.operator && typeof telegram.operator === "object" ? telegram.operator as Record<string, unknown> : {}), enabled };
    updateSettings(this.config.settingsPath, { telegram });
    await this.activity.record("workflow.completed", `Telegram operator mode ${enabled ? "enabled" : "disabled"}`, { telegram: true, operatorMode: enabled });
    return enabled;
  }

  /** Toggles PM MODE (persisted) — Henry operates as a project manager until switched off. */
  async setPmMode(on: boolean): Promise<boolean> {
    this.config.pmMode = on;
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
    settings.pmMode = on;
    await fs.mkdir(path.dirname(this.config.settingsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.activity.record("provider.switched", `PM mode ${on ? "ON" : "OFF"}`, { pmMode: on });
    return on;
  }

  async setProvider(provider: ProviderName): Promise<ProviderName> {
    if (this.config.profileId === "kelly" && provider !== "codex") throw new Error("Kelly is Codex-only; Claude fallback is disabled");
    if (provider !== "codex" && provider !== "claude") throw new Error(`Unknown provider: ${String(provider)}`);
    this.config.provider = provider;
    // Read-merge-write (audit 2026-08-09 M2): a bare {provider} write was wiping
    // every other persisted setting — toggling provider silently disabled PM mode.
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await fs.readFile(this.config.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* fresh */ }
    settings.provider = provider;
    await fs.mkdir(path.dirname(this.config.settingsPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.config.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.activity.record("provider.switched", `Primary provider switched to ${provider}`, { provider });
    return provider;
  }

  /** Full-access engineering task inside any local repository Luvish points Henry at. */
  async task(instruction: string, cwd?: string): Promise<RunResult> {
    const dir = path.resolve(cwd || this.config.rootDir);
    await fs.access(dir).catch(() => { throw new Error(`Task directory does not exist: ${dir}`); });
    await this.activity.record("task.started", `Codebase task in ${dir}`, { cwd: dir, instruction: instruction.slice(0, 240) });
    const result = await this.agent.run(
      [`Work inside the repository at ${dir}. Inspect it before changing anything, run the project's own checks after edits, and summarize every file you changed.`, instruction].join("\n\n"),
      { cwd: dir },
    );
    await this.activity.record("task.completed", `Codebase task finished in ${dir}`, { cwd: dir, exitCode: result.exitCode }, { runId: result.runId, provider: result.provider });
    return result;
  }

  async approve(id: string): Promise<void> {
    await this.approvals.setStatus(id, "approved");
    await this.activity.record("approval.approved", `Approved outbound action ${id}`, { approvalId: id });
  }

  async executeApproval(id: string): Promise<string> {
    const item = await this.approvals.claimForExecution(id);
    try {
      let result: string;
      if (item.kind === "gmail.send") {
        if (!this.gmail) throw new Error("gmail.send approval not available in this profile");
        result = await this.gmail.sendApproved(item);
      } else if (item.kind === "job.application") {
        if (!this.jobs) throw new Error("job.application approval not available in this profile");
        result = await this.jobs.submitApproved(item);
      } else if (item.kind === "github.merge") {
        result = await this.reviewer.mergeApproved(item);
      } else if (item.kind === "github.rollback") {
        result = await this.reviewer.rollbackApproved(item);
      } else if (item.kind === "social.x-post") {
        if (!this.xBrowser) throw new Error("social.x-post approval not available in this profile");
        result = await this.xBrowser.submitApproved(item);
      } else {
        result = await this.reviewer.postApproved(item);
      }
      await this.approvals.setStatus(id, "executed", result);
      return result;
    } catch (error) {
      await this.approvals.setStatus(id, "failed", String(error));
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const profile = getActiveProfile();
    const status: Record<string, unknown> = {
      name: profile.name,
      user: "Luvish",
      provider: this.config.provider,
      rootDir: this.config.rootDir,
      dashboard: `http://${this.config.host}:${this.config.port}`,
      approvals: (await this.approvals.list("pending")).length,
      memory: this.memory.engine.stats(),
      // Live limit/cooldown state per provider CLI ({} when both are healthy) — the
      // failover layer's ledger (providers/limits.ts), surfaced for :status and the page.
      providers: limitState(),
    };
    // Only include jobs status if jobs service is available
    if (this.jobs) status.jobs = await this.jobs.store.summary();
    return status;
  }

  private closing?: Promise<void>;

  close(): void {
    this.scheduler.stop(); this._workflowEngine?.stop(); this._telegramPump?.stop(); this._standupPoller?.stop(); this._standupStore?.close(); this._voiceTranscripts?.close();
    // Agent replies stream/return before durable conversation capture completes.
    // Defer only the memory close; shutting it immediately caused one-shot `ask`
    // commands to log "database connection is not open" and lose the memory.
    this.closing ||= this.agent.flushMemoryCaptures().finally(() => {
      this.memory.close();
      this._knowledge?.close();
      this.commerce?.close();
    });
  }
}
