# Remote access (the shop tablet)

Kelly runs on the shop's Mac, bound to `127.0.0.1` only, the same as every other
mode. Remote access does not change that: it starts a tunnel process that forwards
a device on the counter, a tablet, into that loopback address. Kelly never binds
beyond loopback, never installs a binary, and never runs without an admin account
once a tunnel is configured.

Primary transport is Tailscale Serve, tailnet-only. Cloudflare Tunnel is the fallback for a
shop that cannot put a tailnet on the tablet, and is also the simplest way to put Kelly on your
own domain — see "Your own domain (Cloudflare)" right below. Tailscale Funnel is a third,
public mode — see "Public link (Tailscale Funnel)" below — for a demo or storefront link anyone
can open without owning a domain.

## Your own domain (Cloudflare) — recommended

The simplest way to reach Kelly at `https://kelly.<your-domain>` instead of a tailnet or a
Tailscale-issued hostname.

**Requirements:** your domain's DNS is on Cloudflare (a free Cloudflare account is enough — you
do not need a paid plan), and `cloudflared` installed on the Mac.

1. Install `cloudflared`:
   ```bash
   brew install cloudflared
   ```
2. Run the one setup command, giving it the public hostname you want:
   ```bash
   kelly tunnel setup kelly.your-domain.com --name kelly-shop
   ```
   The first time, this opens your browser so you can log into Cloudflare and pick the domain
   (`cloudflared tunnel login`) — approve it there and return to the terminal, which waits for
   you. Kelly then creates the named tunnel (`kelly-shop` here; without `--name` the code
   uses its built-in default name), points `kelly.your-domain.com` at it in Cloudflare DNS, and writes `KELLY_TUNNEL=cloudflare`,
   `KELLY_CLOUDFLARE_TUNNEL`, and `KELLY_PUBLIC_HOST` into the repo's `.env` (a `.env.bak` copy
   of the previous file is kept alongside it). Every step is skipped automatically if it was
   already done, so running the command again is safe.

   Check readiness at any time without changing anything:
   ```bash
   kelly tunnel setup --status
   ```
   This reports whether `cloudflared` is installed, whether you are logged in (never the
   contents of the credential file), the tunnel name and whether it exists, `KELLY_PUBLIC_HOST`,
   and whether DNS for that host resolves.
3. Create the accounts and start Kelly:
   ```bash
   kelly users add owner --role admin --demo boutique
   kelly users add counter --role counter --demo boutique
   kelly start --demo --trade boutique --public
   ```
   Because `KELLY_CLOUDFLARE_TUNNEL` is now set, `--public` automatically chooses Cloudflare
   over Tailscale Funnel (`--public cloudflare` forces it explicitly; `--public tailscale`
   starts Tailscale Serve instead, which is tailnet-only). Kelly is reachable at
   `https://kelly.your-domain.com`.

**Stop it:** Ctrl+C in Kelly's window stops Kelly and the `cloudflared` process together.

**Remove it later:**
```bash
cloudflared tunnel delete kelly-shop
```
and delete the `kelly.your-domain.com` DNS record from the Cloudflare dashboard (Websites →
your domain → DNS).

**Security note.** As with Tailscale Funnel below, anyone with the link reaches Kelly's login
page — there is no additional network-level gate by default. Kelly's own password is the gate
(same throttling as any other login). For an extra lock, add a Cloudflare Access policy for the
hostname in the Cloudflare Zero Trust dashboard (Access → Applications) requiring, for example,
an email login before the tablet ever reaches Kelly's own login page.

## Setup: Tailscale (recommended for a tailnet)

1. Install Tailscale on the Mac (`https://tailscale.com/download`) and sign it into
   your tailnet. Install the Tailscale app on the tablet and sign it into the same
   tailnet.
2. Create an admin account for yourself if you have not already:
   ```bash
   kelly users add owner --role admin
   ```
3. Add a counter account for the tablet, scoped to the counter role:
   ```bash
   kelly users add counter --role counter
   ```
4. In `.env`, set:
   ```bash
   KELLY_TUNNEL=tailscale
   ```
5. Start Kelly:
   ```bash
   kelly dashboard
   ```
   or, to start the local voice worker too, skip step 4 and run
   `kelly start --public tailscale` (`kelly start` sets `KELLY_TUNNEL` from its own flags
   and ignores the `.env` value). Kelly prints one line once Tailscale Serve is up: `Remote access: https://<your-mac>.<tailnet>.ts.net`.
6. Open that URL on the tablet's browser and log in with the counter account.

Kelly runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` and reads
`tailscale status --json` to learn the https hostname. It never touches your
Tailscale ACLs or account; it only asks the already-signed-in `tailscale` CLI to
serve the port Kelly is already listening on.

## Public link (Tailscale Funnel)

Use this for a demo or storefront link anyone can open — not just devices on your tailnet — when
you would rather not set up a Cloudflare domain (see "Your own domain (Cloudflare)" above).
Unlike Tailscale Serve above, Funnel is public: anyone with the URL reaches Kelly's login page.
Start it manually each time; Kelly never installs a login item or a LaunchAgent, and nothing
starts on its own when the Mac boots.

1. Install Tailscale on the Mac and sign in:
   ```bash
   brew install --cask tailscale
   ```
   Open Tailscale.app once and sign in to your tailnet.
2. Enable HTTPS certificates and the Funnel node attribute for this tailnet in the Tailscale
   admin console:
   - HTTPS certificates: https://login.tailscale.com/admin/dns
   - Funnel (ACLs / node attributes): https://login.tailscale.com/admin/acls
3. Create the accounts the public demo will use, scoped to the demo's own data:
   ```bash
   kelly users add owner --role admin --demo boutique
   kelly users add counter --role counter --demo boutique
   ```
   Kelly prints which data directory it used. Every password must be at least 10 characters —
   use long, unique passwords for a public link, since the password is the only thing standing
   between the internet and this login page.
4. Start the public demo:
   ```bash
   kelly start --demo --trade boutique --public
   ```
   This sets `KELLY_TUNNEL=funnel` for the demo instead of the usual tunnel-off default (every
   other demo isolation — separate data, memory, knowledge, and catalogue — is unchanged).
   `--public` also works without `--demo` for a real install (`kelly start --public`), meaning
   the same thing: a public tunnel instead of tunnel-off.

   Bare `--public` only picks Funnel when the repo's `.env` has no `KELLY_CLOUDFLARE_TUNNEL` —
   if you have already run `kelly tunnel setup` (see "Your own domain (Cloudflare)" above),
   `--public` picks Cloudflare instead. Note that `--public tailscale` does not force Funnel:
   it sets `KELLY_TUNNEL=tailscale`, which is Tailscale Serve (tailnet-only). With a
   Cloudflare tunnel configured, there is currently no `kelly start` flag that forces Funnel;
   use `KELLY_TUNNEL=funnel` with `kelly dashboard` instead. `--public cloudflare` forces
   Cloudflare.

   Kelly prints the public `https://…` link once Funnel is up, the same way Serve does. Because
   a tunnel is active and this is darwin, Kelly also runs `caffeinate -i -w <kelly pid>` beside
   itself, logging "Keeping this Mac awake while Kelly is online." so the Mac cannot idle-sleep
   while the demo is running; it never changes display-sleep settings, and it exits the moment
   Kelly does.

5. Stop it: Ctrl+C in Kelly's window stops Kelly, the tunnel, and `caffeinate` together. If
   anything is left over (a crash, a killed terminal), turn Funnel off directly:
   ```bash
   tailscale funnel --https=443 off
   ```

**Security note.** Public means anyone who has the link can reach the login page — there is no
tailnet or Cloudflare Access layer in front of it, only Kelly's own login. A counter account can
open `/chat` and `/voice` (which run Codex on this Mac) but cannot reach mission control,
approvals, settings, or any admin-only route. Failed logins are throttled the same as any other
login (5 wrong passwords locks that account for 15 minutes).

**Common failures and fixes**, from Kelly's own plain-language error:
- *Funnel not enabled for this tailnet or node* — enable HTTPS certificates and the Funnel node
  attribute in the admin console links above, then try again.
- *Tailscale is not signed in on this Mac* — run `tailscale up`.
- *Binary missing* — install Tailscale from https://tailscale.com/download or
  `brew install --cask tailscale`; Kelly never downloads it for you. Kelly also looks for the
  CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` if it is not on PATH.

## Setup: Cloudflare Tunnel (manual, fallback)

`kelly tunnel setup <hostname>` above does all of this automatically and is the recommended
path. Use the manual steps below only if you want to create or route the tunnel yourself (for
example, reusing a tunnel already managed outside Kelly).

1. Install `cloudflared` on the Mac and create a named tunnel and a DNS route for
   it, following Cloudflare's own tunnel setup for your account. Kelly does not
   create or manage the tunnel itself, only runs it.
2. Add a Cloudflare Access policy restricting the tunnel's hostname to the people
   who should reach it; Kelly's own login is the second layer behind that.
3. In `.env`, set:
   ```bash
   KELLY_TUNNEL=cloudflare
   KELLY_CLOUDFLARE_TUNNEL=my-kelly-shop
   ```
4. Start Kelly the same way (`kelly dashboard`). Kelly prints the URL once the
   tunnel registers a connection, or reports that the hostname comes from your
   Cloudflare configuration when the log line does not carry one.

If `cloudflared` exits, Kelly restarts it with a backoff (5 seconds, doubling to a
60 second cap) and keeps counting the restarts in `kelly tunnel status`.

## Users

Two roles: `admin` (full mission control) and `counter` (the shop tablet).

```bash
kelly users add <username> --role admin|counter   # prompts for a password, hidden as you type
kelly users add <username> --role admin|counter --password-stdin   # reads the password from stdin instead
kelly users list                                  # JSON: username, role, createdAt, never a hash
kelly users remove <username>
kelly users set-password <username>                # same prompt/--password-stdin rules as add
```

Add `--demo boutique|electrical` to any of the subcommands above to manage accounts for a demo
instance instead of the real install — the data directory Kelly uses is exactly the one
`kelly start --demo --trade <t>` resolves (`data/demo-boutique/data` or `data/demo/data`, an
absolute path). Kelly prints which data directory it used, e.g.:

```bash
kelly users add owner --role admin --demo boutique
kelly users add counter --role counter --demo boutique
```

Every password must be at least 10 characters; a shorter one is refused with a plain
error before anything is written to disk. Passwords are always scrypt-hashed with a
fresh per-user salt, whether typed or piped in.

## What Kelly refuses to do

- Bind the dashboard beyond `127.0.0.1`. The tunnel forwards into loopback; the
  bind address itself never moves.
- Install or download Tailscale, cloudflared, or anything else. Both binaries must
  already exist on the Mac's PATH (or at `KELLY_TAILSCALE_PATH` /
  `KELLY_CLOUDFLARED_PATH`); a missing binary fails closed with a plain sentence
  instead of Kelly fetching one.
- Start a tunnel with no admin account configured. `kelly tunnel start` (and the
  automatic start on `kelly dashboard` / `kelly repl`) refuses until
  `kelly users add <name> --role admin` has run at least once.

## Security model

- The loopback admin bypass, the shortcut that lets an already-local terminal skip
  login, turns off automatically while a tunnel is active (`runtime.tunnel.active`).
  A tablet reaching Kelly over the tunnel always sees the real login page. If the
  tunnel's own status ever cannot be read, Kelly fails closed and treats that the
  same as a tunnel being active, rather than quietly reopening the bypass.
- Login is throttled the same way for every caller, local or tunnelled: 5 wrong
  passwords for one username inside 15 minutes locks that account for 15 minutes,
  with a plain message on the login page telling you how long is left. A
  successful login clears the count.
- The counter role's entire reach is chat and counter voice: `/chat`, `/voice`,
  and their supporting APIs (chat send/history/clear, conversations, attachments,
  skills, voice status/transcribe/speak, health, status, logout). It cannot open
  mission control, read approvals, read voice transcripts kept for the owner,
  change the provider or any other setting, or approve or execute anything by
  typing the approval words into chat, even in a voice transcript. Visiting `/`
  as a counter account redirects straight to `/chat`; every other admin-only
  route answers 403.
- Check the tunnel from the command line at any time:
  ```bash
  kelly tunnel status
  ```
  or from the dashboard's Overview pane, which shows a `remote` pill: off,
  the tunnel's hostname when it is active, or the plain failure reason.
