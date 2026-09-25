# The public link: Explore Kelly

When Kelly runs with a tunnel (`kelly start --public`, Tailscale Funnel, or Tailscale Serve), the
link shows **Explore Kelly**: a landing page and three ways to talk to Kelly. It never shows the
owner's dashboard, and nothing a visitor does can reach the shop's real data.

| Page | What it is |
| --- | --- |
| `/` | The Explore landing page (`src/dashboard/explore.html`) |
| `/explore/talk` | Hands-free voice: Silero VAD, a spoken reply, the designs slideshow |
| `/explore/counter` | Tap to talk (or type), with the reply typed out and spoken |
| `/explore/chat` | Text chat: no conversation list, history, attachments, or commands |

## What the tunnel can reach

`src/dashboard/server.ts` runs **the tunnel gate** before any login check. A request counts as
public when it carries any Cloudflare, Tailscale, or proxy header, when its `Host` is not a
loopback name, or when its socket peer is not loopback. It fails closed: a request can only look
*more* public. A public request without a session reaches only this allowlist
(`PUBLIC_TUNNEL_ROUTES` in `src/public/surface.ts`). Anything else gets a 404, and page requests
are redirected to `/`.

```
GET  /  /explore/talk  /explore/counter  /explore/chat
GET  /manifest.webmanifest  /icon-192.png  /icon-512.png  /vendor/vad/<asset>  /holo.js  /constellation.js
GET  /api/health
GET  /api/public/config  /api/public/heartbeat
GET  /api/public/voice/greeting|reprompt|filler
POST /api/public/chat  /api/public/reset  /api/public/voice/transcribe  /api/public/voice/speak
GET  /api/public/designs/<id>/image|thumb
```

`tests/public-routes.test.ts` reads every route registered in `server.ts` and requests each one
through a fake tunnel, with every method. Only the allowlist may answer.

**Owner and counter login are off through the tunnel by default.** The link has no login page.
Set `KELLY_REMOTE_LOGIN=on` to bring back the existing login. You need it for a shop tablet that
reaches Kelly over a tunnel, including Tailscale Serve. With login on, a tunnel session works as
it does today, with these extra protections:

- the Origin must match exactly; a state change with no Origin is refused
- the session cookie is `Secure` and `SameSite=Strict`
- failed logins are throttled per username, never per client address

The owner's own browser on `127.0.0.1` sees no change.

## Who answers a visitor

A visitor's message never reaches Kelly's normal agent. For each turn:

1. **The server does the lookups.** It finds matching rows from the *published* catalogue or
   rate card. When the visitor names quantities, it calculates the quotation in integer paise
   with Kelly's own `calculateLine`. The prompt gets the results as data. Supplier file paths,
   document ids, and row locations are left out. No quote is saved, no discount is applied, and
   no Excel file is created. A boutique browse ask ("show me bridal lehengas") is answered from
   the design gallery by code, and the shown counts are left unchanged.
2. **The model runs with no tools** (`src/providers/public-sandbox.ts`). Kelly is Codex-only, so
   this is `codex exec` with:
   - `--ephemeral --sandbox read-only --ignore-user-config --ignore-rules`
   - `--disable` for the shell, apps, plugins, browser/computer use, hooks, memories, and similar
     features
   - `approval_policy=never`, `web_search=disabled`, `project_doc_max_bytes=0`
   - an empty 0700 scratch directory outside the repository as the working directory
   - a minimal environment with no `KELLY_*` keys and no tokens, plus `KELLY_PUBLIC_TURN=1`

   Any event that shows a tool call, or any Codex item that is not a plain message, throws the
   answer away. The Claude flag set (`--tools ""`, `--safe-mode`, an empty strict MCP config,
   `--setting-sources ""`, `dontAsk`) exists only for the shared Henry profile.
3. **`KELLY_PUBLIC_TURN=1` is a hard rail.** While it is set, every approval, claim, send, and
   quote export refuses, `kelly <anything>` refuses to run, and the provider runner refuses to
   start a nested run.
4. **An output guard runs sentence by sentence** (`src/public/guard.ts`). A reply that looks like
   a local path, a private Kelly file, a credential, or Kelly's prompt text is replaced with a
   polite refusal.
5. **Visitor text is untrusted.** It is quoted inside the prompt, and angle brackets are
   neutralised so it can never open or close a prompt section.

Kelly keeps her shop persona (trade pack, `KELLY_PUBLIC_SHOP_NAME` or `KELLY_SHOP_NAME`). She
understands English, Hindi, Hinglish, and Roman Hindi. She speaks in simple English on the voice
pages and answers in the visitor's style in chat.

## What is and is not kept

Kept in memory only:

- A visitor is a random `kelly_visitor` cookie (HttpOnly, and Secure through the tunnel).
- Their last 20 turns are held so follow-up questions make sense.
- The history is forgotten after 15 idle minutes.
- Visitors never see each other. `/api/public/voice/speak` only speaks a reply Kelly already
  gave to *that* visitor.

Never written: a public turn is never written to:

- the conversation store
- the voice transcript store (no transcript row, no audio file)
- Engram memory
- the quotes store
- the activity log's content

Written, and content-free:

- `<KELLY_DATA_DIR>/logs/public.log`, a rotated JSONL log. It holds method, path, status,
  duration, a one-way visitor hash, the Cloudflare ray id, and turn timings and outcomes. It
  never holds message text, audio, replies, or IP addresses.
- Activity events for failed or blocked public turns, with reasons only.
- The tunnel's own connect and disconnect events.

## Limits

These are `KELLY_PUBLIC_*` settings in `KELLY.env.example`:

- 1000 characters per message
- 2 MB and 30 seconds per recording
- per-visitor and per-client rate limits (Cloudflare's client address is used only as a
  rate-limit key, and only for requests that came through the tunnel)
- two model turns at a time, then a short queue, then a polite busy line

## Voice assets

The public voice pages load the Silero VAD bundle, its model, and the onnxruntime-web wasm from
jsDelivr. The versions are pinned to the exact installed packages, and the bytes are checked
against `node_modules`, with SRI on the script. The shop's home upload therefore never serves
the roughly 14 MB wasm. If the CDN is unreachable, the page falls back to this server's
`/vendor/vad/`, which is cached for a year. The page never waits for the download: it starts
listening with a simple energy detector and switches to Silero between utterances.

## Residual risks

- The model still reads visitor text. A prompt injection can make Kelly *say* something odd or
  off-brand, and the guard only catches the leak patterns listed above. It cannot make her read
  a file, run a command, or act: there is no tool, and the event check discards any answer that
  shows one.
- Published catalogue prices and design photos are visible to anyone with the link, as they
  would be at the counter.
- A future Codex release could add a tool that the disabled-feature list does not cover. The
  fail-closed event check still throws the answer away, and the rail still blocks every owner
  action. After a Codex upgrade, run `npm test`: `tests/public-sandbox.test.ts` checks every flag
  and feature name against the installed CLI.
- Turning `KELLY_REMOTE_LOGIN` on puts a password prompt on the internet. Use long, unique
  passwords.
