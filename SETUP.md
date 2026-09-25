# Setting up Kelly

This runbook takes a fresh clone of Kelly to a working shop install: a counter
tablet on the Talk page, voice in and out, quotations from the shop's own
catalogue or rate card, a design gallery for a boutique, and optionally a public
link and Telegram on the owner's phone.

- **You are an AI coding agent** (Claude Code, Codex, or similar) and the owner
  said "set this up for my shop": first run the conversation in
  [SETUP-PROMPT.md](SETUP-PROMPT.md), then work through this file in order. Run
  each command yourself, compare it with the **Expect** line, and stop at a
  failure: diagnose it or report it. Steps marked **OWNER** need the owner's own
  hands (a browser login, a password, a tablet).
- **You are the shop owner doing it by hand**: follow the same steps. Each one
  says what success looks like.

Kelly is built on the Henry runtime. Henry-only features (Gmail, jobs, PR
review, standups, social posting) are switched off in Kelly and are not covered
here.

Three rules for the whole runbook:

1. **Never print a secret.** Tokens and passwords go into `.env` or into the
   owner's own terminal prompt, never into a chat transcript, a commit, or a
   summary.
2. **Never commit private files.** `.env`, `soul.md`, `personality.md`, `data/`,
   `memory/`, and `knowledge/` are ignored by Git on purpose. Catalogues, rate
   cards, design photos, transcripts, and model files stay local.
3. **One `.env` per install.** Every Kelly command reads the repository's `.env`,
   whatever folder you run it from; a value exported in the shell overrides it.
   A second Kelly on the same Mac needs its own `KELLY_DATA_DIR` and
   `KELLY_MEMORY_DIR` (step 4).

---

## 1. Prerequisites

Kelly is developed and tested on **macOS on Apple Silicon** (M1 or later). Other
platforms are untested: `kelly start` opens a macOS Terminal window and uses
`caffeinate`, and the brew commands below are macOS-specific.

You need:

- **Node.js 22 or newer.** The repository has no `.nvmrc` or `engines` field;
  its SQLite dependency (`better-sqlite3` 12.11.1) supports Node 20 through 26,
  and Kelly is developed on Node 22 and newer.
- **git** on PATH (one dependency installs from GitHub).
- **Homebrew** (https://brew.sh).
- **A ChatGPT plan that includes Codex.** Kelly's brain is the Codex CLI signed
  in to the owner's account. There is no other provider.
- About **1 GB of free disk** for speech models (about 310 MB), the Python voice
  environment, and `node_modules`.

Install the command-line tools:

```bash
brew install node git whisper.cpp ffmpeg python@3.12
brew install poppler        # only if you will import supplier PDFs (provides pdftotext)
```

- `whisper.cpp` provides `whisper-cli`, the speech-to-text engine. The formula
  used to be called `whisper-cpp`; that old name still redirects to
  `whisper.cpp` (check with `brew info whisper.cpp`, which lists
  `Old Names: whisper-cpp`).
- `ffmpeg` is needed only for Telegram voice notes, but it is small and useful.
- `python@3.12` is for the Kokoro speech worker. `kokoro-onnx==0.4.9` supports
  Python 3.10 to 3.13, so do not rely on a plain `python3`, which may be older
  or newer. Python 3.12 may already be on the Mac from the python.org
  installer instead of Homebrew; either works. Find the one you have and use
  that exact path wherever this file says `$PY312`:

  ```bash
  command -v python3.12
  # Homebrew:          /opt/homebrew/bin/python3.12
  # python.org build:  /Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12
  PY312="$(command -v python3.12)"
  ```

  If `command -v python3.12` prints nothing, neither is installed: run
  `brew install python@3.12` and try again.

**Verify:**

```bash
node -v                          # v22 or newer
which whisper-cli                # /opt/homebrew/bin/whisper-cli
"$PY312" --version               # Python 3.12.x
```

## 2. Get the code and install

Clone somewhere that is **not** synced by iCloud, Dropbox, or OneDrive (not
`~/Desktop` or `~/Documents` when iCloud "Desktop & Documents" is on). Synced
folders evict files inside `node_modules`, and builds then hang with no error.

```bash
git clone https://github.com/Luvishgulati03/kelly.git ~/kelly
cd ~/kelly
npm install
```

**Expect:** a clean install with no `ERR!` lines. If `better-sqlite3` fails to
build, run `xcode-select --install` and retry.

Optional, to get a `kelly` command on PATH:

```bash
npm link
```

Without it, use `node bin/kelly.mjs <command>` from the repository root. Every
`kelly ...` command in this file works either way.

## 3. Codex (Kelly's brain)

```bash
codex --version || npm install -g @openai/codex
codex login status
```

**Expect:** `Logged in using ChatGPT`. If not, **OWNER** runs `codex login` in
their own terminal (it opens a browser), then re-run `codex login status`.

Kelly forces the Codex provider; there is nothing to select. Never configure
Claude or any other provider for Kelly.

## 4. Private configuration and persona

```bash
cp KELLY.env.example .env
chmod 600 .env
cp soul.example.md soul.md
cp personality.example.md personality.md
```

Edit `.env` and set, from the owner's answers in SETUP-PROMPT.md:

```bash
KELLY_TRADE=boutique          # or electrical; fixed for the life of this install
KELLY_SHOP_NAME=Your Shop     # shown on the dashboard and spoken in the greeting
KELLY_PORT=7338               # keep unless 7338 is taken
```

**Where Kelly keeps its state.** The catalogue, quotes, designs, logins,
settings and memory live in `KELLY_DATA_DIR` and `KELLY_MEMORY_DIR`. When both
are unset, Kelly uses `~/.kelly/data` and `~/.kelly/memory`. That default is
shared by every Kelly checkout for the same macOS user, so:

- **Only Kelly on this Mac:** you may leave them unset.
- **More than one Kelly on this Mac** (a second shop, a test clone, a fresh
  install next to an existing one): set both, to directories no other install
  uses, **before running any `kelly` command** (even `kelly status` or
  `kelly users add` would otherwise read and write the first install's data):

  ```bash
  KELLY_DATA_DIR=~/.kelly-second-shop/data
  KELLY_MEMORY_DIR=~/.kelly-second-shop/memory
  ```

  Use `~/...` or an absolute path; a relative path resolves from the
  repository root. A value exported in the shell overrides `.env`. Also give
  each install its own `KELLY_PORT` and Kokoro port in `KELLY_KOKORO_URL`.

Set `KELLY_SHOP_NAME` **before** importing a boutique rate card: rows without a
brand column are stored under the shop name, and boutique quotes look them up
by that name. If you rename the shop later, import and publish the rate card
again.

Fill in `soul.md` and `personality.md` from the owner interview (see
`docs/design-your-soul.md`). Replace every placeholder. Keep the outbound
approval rule intact. Both files are read from the repository root on every
turn and are ignored by Git.

**Verify:**

```bash
kelly status
```

**Expect:** JSON with `"name": "Kelly"`, `"provider": "codex"`,
`"dashboard": "http://127.0.0.1:7338"`, a `trade` block showing the chosen
trade and shop name, and a data directory that matches `KELLY_DATA_DIR` (or
`~/.kelly/data` when unset). This makes no provider call.

## 5. Voice stack

Kelly never downloads speech models or installs software. Put three files in
`data/voice/models/` (ignored by Git) and create one Python environment in
`data/voice/venv/`.

### 5.1 Download the models

```bash
mkdir -p data/voice/models
curl -L --fail -o data/voice/models/ggml-small-q5_1.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin
curl -L --fail -o data/voice/models/kokoro-v1.0.int8.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
curl -L --fail -o data/voice/models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Sources: the whisper.cpp model repository on Hugging Face
(`ggerganov/whisper.cpp`) and the `model-files-v1.0` release of the
`thewh1teagle/kokoro-onnx` project, the release that matches
`kokoro-onnx==0.4.9` in `scripts/voice/requirements.txt`.

**Verify sizes and checksums:**

```bash
ls -l data/voice/models
shasum -a 256 data/voice/models/*
```

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `ggml-small-q5_1.bin` | 190085487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` (published by Hugging Face) |
| `kokoro-v1.0.int8.onnx` | 92361271 | `6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb` |
| `voices-v1.0.bin` | 28214398 | `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d` |

The byte sizes match the upstream release assets. The two Kokoro checksums come
from a known-good working install, because the GitHub release does not publish
checksums. A size mismatch means a failed or partial download: delete the file
and download it again.

### 5.2 Python environment for Kokoro

```bash
"$PY312" -m venv data/voice/venv   # PY312 from step 1: command -v python3.12
data/voice/venv/bin/pip install -r scripts/voice/requirements.txt
```

**Expect:** `kokoro-onnx-0.4.9` and `soundfile-0.13.1` installed, with their
dependencies (onnxruntime, numpy, and others).

Kelly looks for the interpreter at `data/voice/venv/bin/python`. If you put the
environment elsewhere, set `KELLY_VOICE_PYTHON` in `.env` to its `python` path.

### 5.3 Voice settings in `.env`

`kelly start` finds the three model files in `data/voice/models/` and
`whisper-cli` on PATH by itself. Write the paths and a worker token into `.env`
anyway, so that `kelly voice status`, `kelly voice transcribe`, and Telegram
voice notes see the same settings:

```bash
KELLY_WHISPER_CPP_PATH=/opt/homebrew/bin/whisper-cli
KELLY_WHISPER_MODEL_PATH=data/voice/models/ggml-small-q5_1.bin
KELLY_KOKORO_MODEL_PATH=data/voice/models/kokoro-v1.0.int8.onnx
KELLY_KOKORO_VOICES_PATH=data/voice/models/voices-v1.0.bin
KELLY_KOKORO_URL=http://127.0.0.1:8765
KELLY_TTS_ENGINE=kokoro
```

Generate the worker token straight into `.env` without printing it:

```bash
echo "KELLY_KOKORO_TOKEN=$(openssl rand -hex 32)" >> .env
```

The token must be at least 24 characters. It is shared only between the
dashboard and the local speech worker. If it is missing, `kelly start` makes a
temporary one for each run.

Ports: the dashboard listens on `127.0.0.1:7338` (`KELLY_PORT`) and the speech
worker on `127.0.0.1:8765` (`KELLY_KOKORO_URL`). Both bind to loopback only.

### 5.4 Verify speech recognition

```bash
kelly voice status
```

**Expect:** `"transcription": "configured"`. `"speech"` reads
`unavailable (worker not reachable)` until Kelly is running (step 9).

Round-trip a spoken sentence through whisper.cpp:

```bash
say -o /tmp/kelly-voice-test.wav --data-format=LEI16@16000 "Two suits with lining, needed by Friday."
kelly voice transcribe /tmp/kelly-voice-test.wav --language en
```

**Expect:** the sentence printed back within a few seconds (small spelling
differences are normal).

## 6. Catalogue or rate card

Kelly quotes only from records the owner has published. Imports wait in review
until published. Supported files: `.xlsx`, `.csv`, and `.pdf` (PDF needs
`poppler`).

**Start from the trade's template:**

```bash
kelly catalogue template
```

**Expect:** `{"outputPath": ".../data/templates/boutique-ratecard.xlsx"}` for a
boutique or `.../data/templates/electrical-catalogue.xlsx` for electrical. The
example rows are placeholders.

- Boutique columns: `Code, Garment, Item, Work type, Unit, Rate, GST%`.
- Electrical columns: `SKU, Brand, Name, Category, Unit, Price, GST%`.
  Electrical rows need a brand, a name, and a price. Boutique rows need a name
  and a rate; a missing code is derived from the garment and item.

**OWNER** replaces the example rows with the shop's real items and prices (or
provides an existing supplier spreadsheet, CSV, or PDF). Then:

```bash
kelly catalogue import /path/to/ratecard.xlsx           # add --sheet "<name>" to pick a sheet
kelly catalogue review
kelly catalogue publish <documentId from the import output>
kelly catalogue search "lining"
```

**Expect:** the import prints a `documentId`, the row count, and
`"status": "pending-review"`; `review` lists the document; `publish` reports
`publishedProducts` and `indexed`; `search` returns matching rows. The first
publish downloads a small local embedding model (about 30 MB, from Hugging Face)
once; after that search works offline.

**Check a quotation:**

```bash
kelly quote create --lines "<code> x2"                  # boutique
kelly quote create --lines "<sku> x2" --brand <Brand>   # electrical needs a brand
```

**Expect:** a quote with `"complete": true`, the line, GST, and total in paise
(1 rupee = 100 paise). An unknown code comes back under `unresolved`, not
guessed. `kelly quote export <quote-id> --out ./quote.xlsx` writes an Excel copy.

## 7. Design gallery (boutique only)

The gallery shows photos on the Talk page when a customer asks, for example,
"show me bridal lehengas". Electrical installs have no gallery.

```bash
kelly designs add /path/to/photo-or-folder --category lehenga --tags bridal,trending
kelly designs stats
```

- `--category` is required: `suit`, `saree`, `lehenga`, `blouse`, `kurti`,
  `gown`, or `dupatta`.
- Optional: `--tags` (`trending`, `latest`, `bridal`, `party`, `festive`,
  `casual`, `custom-order`), `--caption "..."`, `--colours a,b`, `--fabric x`,
  `--occasion x`, `--price-band lo-hi`.
- A folder adds every image in it with the same category and tags. Only PNG,
  JPEG, WebP, and GIF are accepted (convert iPhone HEIC photos to JPEG first).
  Images over 8 MB are rejected; duplicates are skipped.

The owner can also upload and tag photos later in the **Designs** pane of the
dashboard.

**Expect:** `kelly designs stats` shows a non-zero `total` and counts per
category.

## 8. Logins: admin and counter

Two roles exist. `admin` is the owner: the full dashboard, approvals, settings,
transcripts. `counter` is the shop tablet: chat, voice, the Talk page, and a
read-only gallery. It can never approve, send, or change settings.

**OWNER** types the passwords (hidden prompt, minimum 10 characters):

```bash
kelly users add owner --role admin
kelly users add counter --role counter
kelly users list
```

**Expect:** `Created user owner (admin).`, `Created user counter (counter).`,
and a list with both. Use long, unique passwords; with a public link the
password is the only lock. Five wrong passwords in 15 minutes lock that account
for 15 minutes.

Other commands: `kelly users set-password <name>`, `kelly users remove <name>`.
For scripted setup, `--password-stdin` reads the password from standard input.

## 9. Start Kelly

```bash
kelly start
```

On macOS this opens a new Terminal window running the dashboard and the speech
worker together. An agent that needs the output in its own shell should run
`kelly start --foreground` as a background process instead. Ctrl+C in that
window stops both.

**Expect**, after a few seconds:

```
Kelly is ready.
Dashboard: http://127.0.0.1:7338
Voice: http://127.0.0.1:7338/voice
Local only. Press Ctrl+C to stop both services.
```

**Verify:**

```bash
kelly voice status
kelly voice speak "Hello from Kelly" --language en --out /tmp/kelly-hello.wav && afplay /tmp/kelly-hello.wav
```

**Expect:** `"speech": "ready"` and an audible sentence. (`speak` refuses to
overwrite an existing file; delete the old one first.)

Open `http://127.0.0.1:7338` in a browser on the Mac. While Kelly runs without
a tunnel, the Mac itself is signed in as admin without a password. Open
**Talk** from the top bar, tap the talk button, allow the microphone, and ask a
question about the shop.

## 10. Counter mode: put the tablet on Talk

The counter account's home page follows the owner's **counter mode**:

| Mode | Counter account lands on | Behaviour |
| --- | --- | --- |
| `review` (default) | `/chat` | Voice transcripts are shown for a typed confirmation first. |
| `conversation` | `/counter` | Tap to talk; replies are spoken, no review step. |
| `talk` | `/talk` | Hands-free: Kelly greets, listens, answers, and listens again. |

For a counter tablet, choose `talk`: in the dashboard open the **Voice** pane,
find the **Counter mode** card, pick `talk`, and click **Save counter mode**.
Alternatively set `KELLY_COUNTER_MODE=talk` in `.env` and restart Kelly; a valid
value there overrides the saved setting.

Voice transcripts are kept on the Mac for 60 days by default. Audio recording
is off by default. Both are adjustable in the same Voice pane.

## 11. Reach Kelly from the tablet

The dashboard always binds to `127.0.0.1`, so another device can only reach it
through a tunnel. Tunnels also give the HTTPS address that tablet browsers
require before they allow the microphone. Every tunnel option needs an admin
account (step 8). While Kelly runs with a tunnel, every device, the Mac
included, must log in.

Pick one:

| Option | Who can open the link | Needs | Start command |
| --- | --- | --- | --- |
| Tailscale Serve | Only devices signed in to the owner's tailnet | Tailscale on the Mac and the tablet | `kelly start --private tailscale` |
| Cloudflare, own domain | Anyone with the link (login page) | A domain whose DNS is on Cloudflare, `cloudflared` | `kelly tunnel setup ...` once, then `kelly start --public` |
| Tailscale Funnel | Anyone with the link (login page) | Tailscale with HTTPS and Funnel enabled | `kelly start --public` (when no Cloudflare tunnel is configured) or `kelly start --public funnel` to force it |

Without `--public` or `--private tailscale`, `kelly start` never starts a tunnel, whatever `.env` says.
While a tunnel is running, Kelly also runs `caffeinate` so the Mac does not idle
to sleep.

### 11.1 Tailscale Serve (private to the owner's devices)

1. **OWNER** installs Tailscale on the Mac (`brew install --cask tailscale-app`
   or https://tailscale.com/download), opens it, and signs in. Installs the
   Tailscale app on the tablet and signs in to the same tailnet.
2. In the Tailscale admin console, enable HTTPS certificates:
   https://login.tailscale.com/admin/dns
3. Start Kelly:
   ```bash
   kelly start --private tailscale
   ```
   **Expect:** a line `Remote access: https://<mac-name>.<tailnet>.ts.net`.

### 11.2 Cloudflare on the owner's own domain

Requirement: the owner's domain uses Cloudflare DNS (a free Cloudflare account
is enough).

```bash
brew install cloudflared
kelly tunnel setup kelly.your-domain.com --name kelly-shop
```

The first run opens a browser for **OWNER** to log in to Cloudflare and pick the
domain. Kelly then creates the named tunnel, adds the DNS record, and writes
`KELLY_TUNNEL=cloudflare`, `KELLY_CLOUDFLARE_TUNNEL`, and `KELLY_PUBLIC_HOST`
into `.env` (keeping a `.env.bak`). Running it again is safe.

**Verify** without changing anything:

```bash
kelly tunnel setup --status
```

**Expect:** `cloudflared` installed, logged in, the tunnel exists, the public
host set, and DNS resolving. Then:

```bash
kelly start --public
```

**Expect:** the dashboard reachable at `https://kelly.your-domain.com`. For an
extra lock, add a Cloudflare Access policy for that hostname in the Cloudflare
Zero Trust dashboard.

To remove it later: `cloudflared tunnel delete kelly-shop`, then delete the DNS
record in the Cloudflare dashboard.

### 11.3 Tailscale Funnel (public, no domain needed)

1. Tailscale installed and signed in on the Mac, as in 11.1.
2. Enable HTTPS certificates (https://login.tailscale.com/admin/dns) and the
   Funnel node attribute (https://login.tailscale.com/admin/acls).
3. `kelly start --public` (or `--public funnel` to force Funnel explicitly; use
   `--private tailscale` instead for tailnet-only Serve).
   **Expect:** a public `https://...ts.net` link printed once Funnel is up.

If Funnel is left on after a crash: `tailscale funnel --https=443 off`.

More detail: [docs/modules/remote-access.md](docs/modules/remote-access.md).

## 12. Set up the tablet

1. Open the HTTPS link from step 11 in **Safari** (iPad) or **Chrome** (Android).
2. Log in as `counter`. With counter mode `talk`, it opens the Talk page.
3. Tap the talk button once. When the browser asks for the microphone, choose
   **Allow**. If it never asks or was denied: on iPad, Settings > Apps > Safari >
   Microphone (or the `aA` menu > Website Settings > Microphone); on Android,
   the lock icon beside the address > Permissions > Microphone.
4. Add a home-screen shortcut: Safari Share > **Add to Home Screen**; Chrome
   menu > **Add to Home screen**.
5. Keep the screen awake: on iPad, Settings > Display & Brightness > Auto-Lock >
   Never; on Android, Settings > Display > Screen timeout at the maximum (or
   Developer options > Stay awake while charging). Keep the tablet on its
   charger. Optional: iPad Guided Access keeps the tablet on this one page.
6. Keep the Mac awake too. `caffeinate` covers idle sleep while a tunnel runs;
   also set System Settings > Battery (or Energy) so the Mac does not sleep on
   power, and keep the lid open or the Mac on power with an external display.

## 13. Telegram on the owner's phone (optional)

1. **OWNER** messages [@BotFather](https://t.me/BotFather), sends `/newbot`,
   and follows the prompts. BotFather replies with a bot token.
2. Put it in `.env` (the owner can paste it into the file directly):
   ```bash
   KELLY_TELEGRAM_BOT_TOKEN=<token from BotFather>
   ```
3. **OWNER** sends any message to the new bot. Then read the chat id:
   ```bash
   curl -s "https://api.telegram.org/bot$(grep '^KELLY_TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-)/getUpdates"
   ```
   Find `"chat":{"id":<number>` and add `KELLY_TELEGRAM_CHAT_ID=<number>` to
   `.env`. An empty `"result":[]` means the bot has not been messaged yet.
4. Voice notes from the owner (optional): add
   `KELLY_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg` (whisper settings from step 5.3
   are also required). Spoken replies are off unless
   `KELLY_TELEGRAM_VOICE_REPLIES=1`.
5. Verify, with the owner's consent (it sends one message to the owner's own
   chat):
   ```bash
   kelly telegram test
   kelly telegram status
   ```
   **Expect:** `ok — check your Telegram chat` and a test message on the phone.

The bot answers only the configured chat id. It runs inside the dashboard
process, so replies work while `kelly start` is running. `kelly telegram off`
turns the two-way chat off. Details: [docs/modules/telegram.md](docs/modules/telegram.md).

## 14. Demo mode (try it first)

```bash
kelly start --demo --trade boutique     # or: --trade electrical (the default)
```

The demo uses a fictional catalogue or rate card and (for boutique) placeholder
design photos, stored separately under `data/demo-boutique/` or `data/demo/`.
The boutique demo shows `KELLY_SHOP_NAME` if set, otherwise a neutral demo name. It
never touches the real install and never connects to Telegram. It runs on port
7338, so stop the real Kelly first. Voice still needs step 5.

Try: "show me trending sarees" or "how much for two salwar suits with lining,
my own fabric, needed by Friday".

To share a demo publicly, create demo-only accounts first:

```bash
kelly users add owner --role admin --demo boutique
kelly users add counter --role counter --demo boutique
kelly start --demo --trade boutique --public
```

## 15. Troubleshooting

**Tablet never asks for the microphone, or the talk button does nothing.**
Browsers allow the microphone only on HTTPS or on `localhost`. A plain
`http://<mac-ip>:7338` address cannot work (and Kelly does not listen on the
network anyway). Use a tunnel link from step 11. If permission was denied once,
reset it in the browser's site settings (step 12).

**`Configure KELLY_KOKORO_MODEL_PATH with an existing local file. No models were downloaded.`**
A Kokoro file is missing or misnamed. Check `ls -l data/voice/models` against
the table in step 5.1.

**`Kokoro worker exited ...` or `TTS dependencies are missing`.**
The Python environment is missing or broken. Re-run step 5.2. Confirm
`data/voice/venv/bin/python -c "import kokoro_onnx"` exits quietly. If the venv
is elsewhere, set `KELLY_VOICE_PYTHON`.

**Speech stops with `Error processing file '/Users/runner/work/espeakng-loader/espeakng-loader/espeak-ng/_dynamic/share/espeak-ng-data/phontab': No such file or directory.`**
The path is not on your Mac: it is where the `espeakng-loader` wheel was
built. espeak-ng (which Kokoro uses to turn text into phonemes) only accepts a
data directory path shorter than 160 characters. When the repository sits
deep in the file system, the path to
`data/voice/venv/lib/python3.12/site-packages/espeakng_loader/espeak-ng-data`
is longer than that, espeak-ng silently falls back to the build path, and the
worker exits on the first sentence. The worker now copies that directory once
to a short temporary path (`kelly-espeak-<hash>` under the system temp
directory) and uses the copy; you do not need Homebrew `espeak-ng`. If it
still happens, update the repository, or point `KELLY_ESPEAK_DATA_PATH` in
`.env` at an absolute path to a copy of `espeak-ng-data` whose full path is under 160 characters.
Moving the checkout to a short path such as `~/kelly` also fixes it.

**`Speech is unavailable: the local voice worker exited ...` in the `kelly start` window.**
The dashboard keeps running (typed chat and quotes still work) and Kelly
restarts the speech worker after 5 s, then 10, 20, 40 and every 60 s. The
worker's own error is printed just above that line; fix it using the entries
here, and speech comes back on the next retry without restarting Kelly.

**`kelly voice status` shows `"transcription": "not configured"`.**
`whisper-cli` is not installed or the paths are not in `.env`, or you ran it
outside the repository root. `brew install whisper.cpp`, then check step 5.3.

**`Port 7338 is already in use` (or 8765).**
Another Kelly (or a demo) is already running. Find it with
`lsof -nP -iTCP:7338 -sTCP:LISTEN` and stop it with Ctrl+C in its window. Kelly
never kills another process for you. To move ports, change `KELLY_PORT` or the
port in `KELLY_KOKORO_URL`.

**Signed out of the dashboard after an update.**
Kelly's session cookie is now called `kelly_sess` (it used to share Henry's
`henry_sess` name). Browsers holding the old cookie must log in once more.

**`kelly status` shows another shop's data, or users you never created.**
Two Kelly installs on this Mac are sharing `~/.kelly`. Give this one its own
`KELLY_DATA_DIR` and `KELLY_MEMORY_DIR` in `.env` (step 4) and run the command
again.

**Login says the account is locked.**
Five wrong passwords in 15 minutes lock that username for 15 minutes. Wait, or
reset it: `kelly users set-password <name>` (the lock itself still runs out on
its own timer).

**Cloudflare link does not load yet.**
Run `kelly tunnel setup --status`. A new DNS record can take a few minutes to
resolve. The domain must be on Cloudflare DNS. `cloudflared` must be installed
and logged in (`cloudflared tunnel login` is run for you by `kelly tunnel setup`).
Start with `kelly start --public` (plain `kelly start` never starts a tunnel).

**Tailscale says Funnel is not enabled, or Tailscale is not signed in.**
Enable HTTPS and the Funnel attribute (step 11.3), or open Tailscale.app and
sign in (`tailscale up`).

**`Create an admin account first` when starting a tunnel.**
Create one first: `kelly users add owner --role admin` (add `--demo <trade>` for
a demo).

**Replies say Codex is logged out.**
Run `codex login` in the owner's terminal, then `codex login status`.

**Codex rejects a model name.**
Kelly's default Codex model names may not be available on every account. Set
`KELLY_CODEX_MODEL`, `KELLY_CODEX_T0_MODEL`, and `KELLY_CODEX_T2_MODEL` in `.env`
to models the owner's Codex account accepts, then restart Kelly.

**Boutique quote says `unresolved` for an item that exists.**
The rate card was imported under a different shop name. Set `KELLY_SHOP_NAME`,
then import and publish the rate card again. Also check it was published
(`kelly catalogue review`).

**Wrong trade, port 7337, or missing settings.**
`.env` is missing or a value was exported in the shell (exported values win).
Check `ls -la .env` in the repository and `env | grep KELLY_`, then run the
command again.

**The install hangs with no error.**
The repository is in an iCloud-synced folder. Move it (step 2), delete
`node_modules`, and `npm install` again.

## 16. Verify it works

- [ ] `kelly status` shows `"name": "Kelly"`, `"provider": "codex"`, the right
      trade and shop name, and port 7338.
- [ ] `codex login status` says logged in.
- [ ] `soul.md` and `personality.md` contain no placeholders or example names.
- [ ] `kelly catalogue review` lists a published document and
      `kelly catalogue search "<an item>"` finds it.
- [ ] `kelly quote create ...` returns `"complete": true` with correct GST.
- [ ] Boutique: `kelly designs stats` shows photos.
- [ ] `kelly users list` shows one admin and one counter.
- [ ] `kelly start` prints `Kelly is ready.` and `kelly voice status` shows
      `"transcription": "configured"` and `"speech": "ready"`.
- [ ] Counter mode is `talk` (Voice pane).
- [ ] On the tablet, the HTTPS link opens, `counter` logs in to the Talk page,
      the microphone is allowed, and a spoken question gets a spoken answer
      with a price from the published list.
- [ ] Optional: `kelly telegram test` reached the owner's phone.
- [ ] `git status --short` shows no private files staged or tracked: `.env`,
      `soul.md`, `personality.md`, and everything under `data/` stay untracked.

## Where things live

| What | Where |
| --- | --- |
| Settings and secrets | `.env` in the repository root (mode 0600) |
| Persona | `soul.md`, `personality.md` in the repository root |
| Runtime data (catalogue, quotes, designs, logins, transcripts, settings) | `KELLY_DATA_DIR` (default `~/.kelly/data`) |
| Owner memory | `KELLY_MEMORY_DIR` (default `~/.kelly/memory`) |
| Speech models and Python environment | `data/voice/models`, `data/voice/venv` |
| Templates and demo data | `data/templates`, `data/demo`, `data/demo-boutique` |

All of these are ignored by Git. Back up the data and memory directories (by
default `~/.kelly`) and `.env` if the shop depends on them.
