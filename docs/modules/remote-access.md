# Remote access (the shop tablet)

Kelly runs on the shop's Mac, bound to `127.0.0.1` only, the same as every other
mode. Remote access does not change that: it starts a tunnel process that forwards
a device on the counter, a tablet, into that loopback address. Kelly never binds
beyond loopback, never installs a binary, and never runs without an admin account
once a tunnel is configured.

Primary transport is Tailscale Serve. Cloudflare Tunnel is the fallback for a shop
that cannot put a tailnet on the tablet.

## Setup: Tailscale (recommended)

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
   Kelly prints one line once Tailscale Serve is up: `Remote access: https://<your-mac>.<tailnet>.ts.net`.
6. Open that URL on the tablet's browser and log in with the counter account.

Kelly runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` and reads
`tailscale status --json` to learn the https hostname. It never touches your
Tailscale ACLs or account; it only asks the already-signed-in `tailscale` CLI to
serve the port Kelly is already listening on.

## Setup: Cloudflare Tunnel (fallback)

Use this when the tablet cannot join a tailnet (a shared shop iPad on guest wifi,
for example).

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
