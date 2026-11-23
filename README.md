# Billion Token Club connector

The Billion Token Club is a public leaderboard of how many tokens people run through Claude Code and Codex, kept by Hourglass AI at [thehourglass.ai/billion-token-club](https://thehourglass.ai/billion-token-club). This connector is the program that does the counting. It reads the history files Claude Code, the Claude desktop app and Codex already keep on your machine, adds up the token counts per day and model, and uploads those totals every 15 minutes. It is two plain JavaScript files (`connect.mjs` and `sync.mjs`) and a short bash installer (`install.sh`), with no dependencies beyond Node.js.

```sh
curl -fsSL https://thehourglass.ai/billion-token-club/install.sh | bash
```

The same files are public at [github.com/HourglassDigital/billion-token-club-connector](https://github.com/HourglassDigital/billion-token-club-connector), a mirror of the files `thehourglass.ai/billion-token-club/` serves, updated whenever they change.

You are right to be wary of piping a script into bash. This page tells you exactly what the connector reads, what it sends, what it installs and how to check all of that yourself before you run anything. The code is the source of truth: where this README and the code ever disagree, the code wins, and we would like to hear about it.

- [What leaves your machine](#what-leaves-your-machine)
- [What never leaves your machine](#what-never-leaves-your-machine)
- [What it reads locally](#what-it-reads-locally)
- [See it before you send anything](#see-it-before-you-send-anything)
- [What it installs](#what-it-installs)
- [Updates and verification](#updates-and-verification)
- [Turn it off](#turn-it-off)
- [How tokens are counted](#how-tokens-are-counted)
- [Requirements and contact](#requirements-and-contact)

## What leaves your machine

The connector talks to one host, `thehourglass.ai`, over HTTPS, and refuses redirects. `connect.mjs` makes no network requests at all; every request comes from `sync.mjs`. There are four kinds.

### 1. Pairing (once per machine)

| Request | Body sent | Why |
| --- | --- | --- |
| `POST /api/token-club/pair/start` | `{"installationId": "<random UUID>"}` | Starts approval. The UUID is generated on your machine with `crypto.randomUUID()` and identifies this installation, nothing else. |
| `POST /api/token-club/pair/poll` (every 5 seconds, up to 10 minutes) | `{"deviceCode": "<43-character code the server issued>"}` | Waits for you to approve. That code becomes this machine's upload credential. |

The terminal then opens (or prints, on a machine with no display) a link to sign in with GitHub. The GitHub sign-in happens in your browser, not in the terminal, and the connector never sees your GitHub credentials. On the approval page you choose:

- a **display name** (prefilled from your GitHub profile name, editable, up to 80 characters), shown publicly;
- a **machine nickname** (up to 60 characters), shown only to you, on your own machines list;
- a consent tick to show your display name, GitHub handle and aggregate usage on the public leaderboard.

From GitHub the server keeps your **numeric GitHub user id** and your **public handle** (login). The sign-in requests no OAuth scopes, so it gets only your public profile. It does not store your email, avatar or the GitHub access token: the token is used once to read your public profile and is then discarded.

### 2. Usage upload (every 15 minutes)

`POST /api/token-club/sync` with `Authorization: Bearer <this machine's credential>` and this JSON body. The server checks it against a strict allowlist and rejects any request with an extra field, so this is the whole upload contract:

```json
{
  "schemaVersion": 1,
  "connectorVersion": "0.2.9",
  "status": "partial",
  "coverage": { "from": "2026-05-07", "to": "2026-11-23" },
  "usage": [
    {
      "day": "2026-11-22",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "input": 1200,
      "output": 48310,
      "cacheRead": 9412775,
      "cacheCreation": 301442,
      "reasoning": 0,
      "total": 9763727,
      "requests": 214
    },
    {
      "day": "2026-11-22",
      "provider": "codex",
      "model": "gpt-5.5",
      "input": 3104220,
      "output": 28905,
      "cacheRead": 2870016,
      "cacheCreation": 0,
      "reasoning": 9312,
      "total": 3133125,
      "requests": 41
    }
  ],
  "diagnostics": [
    { "provider": "claude", "code": "synthetic_ignored", "count": 87 },
    { "provider": "codex", "code": "missing_context", "count": 198 }
  ]
}
```

| Field | What it is |
| --- | --- |
| `schemaVersion` | Always `1`. |
| `connectorVersion` | The connector's version, for example `0.2.9`. |
| `status` | `ok`, or `partial` when some history could not be read or counted cleanly (the diagnostics say why). |
| `coverage.from`, `coverage.to` | The first and last UTC day with counted usage. Not a claim that every day in between is covered. |
| `usage[]` | One row per UTC day, provider and model. Your full local history goes up on every sync, so a machine with six months of history sends a few hundred rows. |
| `usage[].day` | UTC date, `YYYY-MM-DD`. |
| `usage[].provider` | `claude` or `codex`. |
| `usage[].model` | The model name, which must match a fixed list of Claude and OpenAI model name patterns in `connect.mjs` (for example `claude-opus-4-6`, `gpt-5.5`). Anything else is not counted and is never sent. |
| `usage[].input`, `output` | Input and output tokens. |
| `usage[].cacheRead`, `cacheCreation` | Cache reads and cache writes. For Claude these are on top of `input`; for Codex the cached part is a subset of `input`. |
| `usage[].reasoning` | Codex reasoning tokens, a subset of `output`. Always 0 for Claude. |
| `usage[].total` | Claude: `input + output + cacheRead + cacheCreation`. Codex: `input + output`. The server rejects a row where this does not add up. |
| `usage[].requests` | How many distinct Claude messages or Codex usage records made up the row. Not a provider-verified request count. |
| `diagnostics[]` | Up to 100 fixed codes with counts, such as `synthetic_ignored`, `other_machine_ignored`, `unsupported_model`, `missing_default_root`. A code must match `^[a-z_]{1,50}$`, so it can never carry a path or text. |

### 3. Update checks (every background run)

Plain `GET` requests with no body for `release.json` and `release.sig`, and, only when a new version is published, `connect.mjs` and `sync.mjs`. See [Updates and verification](#updates-and-verification).

### 4. Removal

`POST /api/token-club/uninstall` with the credential and an empty body `{}`, when you run the uninstall command.

### What the server keeps, and who sees it

This part you cannot check from the connector code, because it runs on our server. Per member: GitHub numeric id, handle, display name and whether you chose to hide your name. Per machine: the installation UUID, a SHA-256 hash of the credential (not the credential itself), your nickname, the time and error code of the last sync, the coverage dates, the partial flag, the connector version, a SHA-256 fingerprint of the uploaded rows (used to spot two machines uploading the same history) and the usage rows. Diagnostics are checked on upload and not stored. As with any website, our host sees the IP address of each request; pairing requests are rate limited using a keyed hash of that address, kept until the rate window expires.

Anyone can see your display name and handle (unless you hide your name), your Claude, Codex and total tokens, your rank and the first day of your history, plus aggregate statistics across all members. Signed-in members, and visitors who unlock the full report with their email, also see a per-member breakdown: total, last 30 days, Claude and Codex, the fresh input, cached and output split, and the number of active days. Your machine nicknames, per-model rows and daily history are shown only to you.

## What never leaves your machine

These are guarantees of the upload contract above: the server rejects any field not listed there, and the connector builds the payload only from counters, dates and model names.

- Prompts, responses, tool calls, code and file contents.
- File paths, project names, folder names and file names, including the history folders the home-folder search finds and the working folder recorded in each message.
- Session ids, message ids and response ids (used locally to avoid double counting, then dropped).
- Your Claude, Anthropic, OpenAI or ChatGPT credentials. The connector does not read the files that hold them; it reads only the history and summary files listed below.
- Plan or usage pages. The connector never contacts Anthropic, OpenAI or any site other than `thehourglass.ai`.
- Everything the connector prints about this machine: per-folder and per-month totals, the list of folders found, warnings and skipped-file codes. These go to your terminal and to the local log `last-sync.json` only.

To find the usage numbers, the connector does parse every line of your history files in memory, prompts included. It keeps only the counters, the timestamp's UTC day and the model name.

## What it reads locally

Everything is opened read-only. Symbolic links inside history folders are not followed, and a file reached by two paths is read once.

**Claude Code** (CLI and IDE extensions)

- `~/.claude/projects/` and `~/.claude/transcripts/`, and the same under `$XDG_CONFIG_HOME/claude` (default `~/.config/claude`). If `CLAUDE_CONFIG_DIR` is set (a comma-separated list), its folders replace those two.
- `~/.cc-mirror/<variant>/config/projects/`.
- Only `*.jsonl` files.
- `stats-cache.json` in each Claude config folder (the summary behind Claude Code's `/stats`), for deleted history. Files over 8 MiB are skipped.
- `~/.claude/settings.json`, only to read `cleanupPeriodDays` and print a tip if Claude Code is set to delete your history. The connector never writes to it.

**Claude desktop app** (Cowork and Claude Code inside the app)

- Every `.claude/projects` and `.claude/transcripts` folder at any depth under `local-agent-mode-sessions` and `claude-code-sessions` in `~/Library/Application Support/Claude` (macOS) or `$XDG_CONFIG_HOME/Claude` (Linux). `audit.jsonl` is a second copy of the same traffic and is never counted.

**Codex** (CLI, IDE extension, desktop app)

- `~/.codex/sessions/` and `~/.codex/archived_sessions/`, or the same under each folder in `CODEX_HOME` (comma-separated). Only `*.jsonl` files; compressed `.jsonl.zst` logs are not read.
- The highest-numbered `state_<n>.sqlite` in each Codex folder, for deleted history: only the `threads` table's `tokens_used`, `model`, `created_at` and `rollout_path` columns. It is opened read-only (`mode=ro`) with Node's built-in `node:sqlite` and is never written.

**Other history folders: the home-folder search**

People keep history in folders no default covers (a second Claude config folder, a `CODEX_HOME` used for a side project). The installed sync looks for them at install, when you run `--review`, and at most once a week. The search:

- starts at your home folder only, never `/` or another user's home;
- reads directory names, never follows a link, and never crosses onto another disk or network mount;
- stops at depth 6, 200,000 directory entries or 10 seconds, whichever comes first;
- skips `node_modules`, `.git`, `.cache`, `.npm`, `.cargo`, `.rustup`, `.venv`, `venv`, `site-packages`, `go/pkg`, `Pictures`, `Movies`, `Music`, `.Trash`, `.local/share/Trash`, `Library/Caches`, `Library/Mail`, `Library/Messages`, `Library/Photos`, and `Library/Containers` except Claude's own;
- treats a folder as a candidate only by its layout (`projects/<folder>/*.jsonl` for Claude, `sessions/YYYY/MM/DD/rollout-*.jsonl` for Codex), then confirms it by reading the first 64 KB of its newest file once and checking the keys of at most 5 lines. Those bytes are discarded.

Every folder that passes is counted, and the paths found are printed on your terminal so you can see them. They are kept in `roots.json` in the install folder and never uploaded. To stop counting one, see [Turn it off](#turn-it-off).

On WSL the connector also asks, on a terminal, whether to look in `/mnt/c/Users/*/.claude` and `/mnt/c/Users/*/.codex`, and then asks about each folder found there by path, since it may belong to another Windows user. Nothing there is counted without a yes.

## See it before you send anything

`connect.mjs` on its own is a read-only exporter. It makes no network requests, opens no browser and writes no files. You can download just that file and run it anywhere:

```sh
curl -fsSLO https://thehourglass.ai/billion-token-club/connect.mjs
node connect.mjs --dry-run    # human summary: totals, per-folder months, history tip
node connect.mjs --json       # the exact upload body, as JSON
```

`--json` prints the same `schemaVersion`, `connectorVersion`, `status`, `coverage`, `usage` and `diagnostics` object the sync uploads. Pipe it to a file and read it, or count the rows with `node -e 'console.log(require("./out.json").usage.length)'` after `node connect.mjs --json > out.json`. A full scan of a large history can take a minute or two.

Exit codes: `0` for a clean scan, `2` for partial coverage (it still prints everything), `1` for no usable history or bad arguments.

Two differences from the installed sync, both deliberate:

- The standalone exporter does not run the home-folder search, so it counts the default folders only (plus `CLAUDE_CONFIG_DIR` and `CODEX_HOME` if you set them). The installed sync also counts the folders the search found.
- `--dry-run` is a label for reading: `connect.mjs` never uploads with or without it.

To see exactly what the installed sync would upload, including found folders, run this from the install folder. It uses the installed `connect.mjs` and your `roots.json`, and only reads:

```sh
cd "$HOME/Library/Application Support/Hourglass Token Club"   # Linux: cd "${XDG_STATE_HOME:-$HOME/.local/state}/hourglass-token-club"
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { scan } from "./connect.mjs";
const roots = JSON.parse(readFileSync("roots.json", "utf8")).roots ?? {};
const extraRoots = Object.entries(roots).filter(([, v]) => v.answer !== "no").map(([path, v]) => ({ path, provider: v.provider }));
const { data } = await scan({ extraRoots });
console.log(JSON.stringify(data, null, 2));'
```

If you installed with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set, set them the same way before running it.

Do not use `sync.mjs --json` to preview: it performs a real sync and uploads, then prints the server's reply as JSON.

## What it installs

The installer checks for Node.js 20 or newer, downloads `release.json`, `connect.mjs` and `sync.mjs` into a temporary folder, checks each script's SHA-256 against `release.json`, copies them into the install folder and runs `node sync.mjs --install`, which starts the GitHub approval and sets up the schedule. It never asks for a password, never uses `sudo`, installs no packages and refuses to install into a folder that is a symbolic link.

| | macOS | Linux |
| --- | --- | --- |
| Install folder | `~/Library/Application Support/Hourglass Token Club` | `${XDG_STATE_HOME:-~/.local/state}/hourglass-token-club` |
| Schedule | A launchd agent, `~/Library/LaunchAgents/ai.thehourglass.token-club.plist` | One line in your user crontab |
| Interval | `StartInterval` 900 seconds, not run at load | `*/15 * * * *` |

The crontab line looks like this; every other line in your crontab is kept exactly as it was:

```
*/15 * * * * '/usr/bin/node' '/home/you/.local/state/hourglass-token-club/sync.mjs' --background >/dev/null 2>&1 # ai.thehourglass.token-club
```

Both schedules run `sync.mjs --background` with the absolute path of the Node.js you installed with. If you later move or replace that Node.js, run the install command again.

Files in the install folder (folder mode `700`, every file mode `600`, owner only):

| File | Contents |
| --- | --- |
| `connect.mjs`, `sync.mjs` | The connector. |
| `config.json` | The random installation UUID, this machine's upload credential and id, the install folder's path, and any `CLAUDE_CONFIG_DIR` or `CODEX_HOME` value set at install. |
| `roots.json` | Folders the home-folder search found, whether each is counted, the WSL answer and the last search time. Never uploaded. |
| `last-sync.json` | A local log of the last sync: time, status, diagnostic codes, update result, and counts of found folders and backfilled days. Counts and fixed codes only, never a path. |
| `sync.lock` | Present only while a sync runs, to stop two overlapping. |

## Updates and verification

**Updates are automatic.** On each background run `sync.mjs` downloads `release.json` and `release.sig`. When the published version differs from the installed one, it downloads both scripts, checks each SHA-256 against `release.json` and swaps them in. The new code runs from the next sync. Any failure leaves the installed files untouched and the sync carries on. Manual runs never update.

**Updates are signed.** `sync.mjs` pins this ed25519 public key (base64 SPKI DER):

```
MCowBQYDK2VwAyEAi0VwqTrl++gyWx7Q3DoieudIpPlQR0b0yuQ3dal+OZk=
```

Before reading anything in a downloaded `release.json`, the updater checks that some line of `release.sig` is a valid signature over its exact bytes under that key. If none is, it refuses the update. Because `release.json` holds the SHA-256 of both scripts, the signature covers the code. During a key change `release.sig` carries one line per key, and any line that verifies is enough.

What the signature does and does not protect against:

- It does protect connected machines from someone who can change files on our website or its hosting but does not hold the signing key: they cannot push code through the updater.
- It does not protect the first install. `install.sh` checks the scripts against `release.json` from the same server, which catches a broken or inconsistent download, not a compromised server. HTTPS is the trust boundary there; you can check the signature yourself, below.
- It does not protect against us. Whoever holds the signing key can ship new code to every connected machine within about 15 minutes. That is the trade-off of automatic updates, and the reason the code is public: you can read each release.
- It does not prevent a downgrade. The updater installs any validly signed release whose version differs from the installed one, so an older signed release could be served again.
- `install.sh` and this README are not covered by the signature.

**Check a download yourself.** Download the files into an empty folder:

```sh
for f in release.json release.sig connect.mjs sync.mjs install.sh; do
  curl --proto '=https' --tlsv1.2 -fsSO "https://thehourglass.ai/billion-token-club/$f"
done
```

Check each script's SHA-256 against `release.json`:

```sh
node -e 'const fs=require("fs"),c=require("crypto");const m=JSON.parse(fs.readFileSync("release.json","utf8"));let ok=true;for(const f of ["connect.mjs","sync.mjs"]){const h=c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");ok&&=h===m.sha256[f];console.log(f,h===m.sha256[f]?"matches":"DOES NOT MATCH",h)}process.exit(ok?0:1)'
```

or by eye, with `shasum -a 256 connect.mjs sync.mjs` on macOS (`sha256sum` on Linux) and `cat release.json`.

Check `release.sig` against the public key. Compare the key in the command with the one above and in the [public repository](https://github.com/HourglassDigital/billion-token-club-connector), not only with the copy inside the `sync.mjs` you just downloaded:

```sh
node -e 'const c=require("crypto"),fs=require("fs");const key=c.createPublicKey({key:Buffer.from("MCowBQYDK2VwAyEAi0VwqTrl++gyWx7Q3DoieudIpPlQR0b0yuQ3dal+OZk=","base64"),format:"der",type:"spki"});const m=fs.readFileSync("release.json");const ok=fs.readFileSync("release.sig","utf8").split("\n").map(s=>s.trim()).filter(Boolean).some(s=>c.verify(null,m,key,Buffer.from(s,"base64")));console.log(ok?"signature OK":"signature FAILED");process.exit(ok?0:1)'
grep -n 'RELEASE_PUBLIC_KEY = ' sync.mjs
```

**Install without piping to bash.** `install.sh` downloads its own fresh copies, so checking your copies does not guarantee it runs the same bytes. To install exactly the files you checked, do by hand what `install.sh` does:

```sh
dir="$HOME/Library/Application Support/Hourglass Token Club"   # Linux: dir="${XDG_STATE_HOME:-$HOME/.local/state}/hourglass-token-club"
mkdir -p "$dir" && chmod 700 "$dir"
install -m 600 connect.mjs sync.mjs "$dir/"
node "$dir/sync.mjs" --install
```

The connector only syncs from that folder; from anywhere else `sync.mjs` stops with "Use the install command from the Token Club page."

## Turn it off

| What you do | On your machine | On our server |
| --- | --- | --- |
| **Uninstall**: `curl -fsSL https://thehourglass.ai/billion-token-club/install.sh \| bash -s -- --uninstall`, or `node "<install folder>/sync.mjs" --uninstall` | Removes the launchd agent or crontab line and deletes `config.json`, `connect.mjs`, `sync.mjs`, `last-sync.json`, `roots.json`, `sync.lock`, and the install folder if nothing else is in it. | Revokes the credential first and deletes the machine and all its usage rows. If the server cannot be reached, nothing is removed locally either; run it again when you are online. |
| **Remove the machine** on the website, under My machines | The next background sync gets a "revoked" reply and removes its own launchd agent or crontab line. The install folder and its files stay until you delete them or run the uninstall command. | Deletes the machine and all its usage rows straight away; further uploads from it are refused. |
| **Stop counting a folder**: `node "<install folder>/connect.mjs" --review` on a terminal | Lists every found folder and asks about each (Enter keeps the current setting). A folder turned off is never counted again, even if a later search finds it. | Future uploads leave it out. Past days already uploaded are not lowered, because the server never lowers a finished day (see below). To remove those counts, remove the machine and install again. |
| **Hide my name**, on your own machines panel on the website | Nothing. | Your name and handle show as "Anonymous member" everywhere public. Your tokens still count in totals, ranks and statistics, and you still see your own name. |

Removing every machine leaves your member record (GitHub id, handle and display name). To have that deleted too, email [hello@thehourglass.ai](mailto:hello@thehourglass.ai).

## How tokens are counted

- **Claude**: input + output + cache reads + cache writes. Each message counts once, by its message id, even when it appears in several files or several streaming snapshots. Zero-usage synthetic messages are ignored. A message whose recorded working folder belongs to the other operating system (a Linux path on a Mac, or the reverse) came from another machine and is skipped, since that machine counts it.
- **Codex**: input + output. Cached input and reasoning are already inside those, so they are not added again. Newer Codex logs record each model response once, and each response id counts once across every file. Older logs are counted from their usage snapshots, file by file, with copies of the same snapshot counted once.
- **Deleted history.** Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days by default) but keeps a daily per-model total in `stats-cache.json`. For each day and model the connector takes the larger of the transcript count and that summary, never the sum. Codex keeps a per-thread total in its SQLite state; a thread whose log file is gone fills only days with no other Codex usage, all on the day the thread started. These rows carry the whole count in `input`, so their input and output split is not meaningful.
- **Days** are UTC, from each record's timestamp. The server refuses days before 2025-01-01, and the deleted-history fill skips them.
- **The server never lowers a finished day.** Because Claude Code deletes old transcripts, a later scan can see less of an old day than an earlier one did; the server keeps the higher count for any day before today (UTC).

Known limits:

- macOS and Linux (including WSL) only. Node.js 20 or newer; the Codex deleted-history fill also needs `node:sqlite` (Node.js 22.13 or newer) and is skipped on older versions.
- Local logs are not provider attestation. Anyone can edit their own history files. The server runs sanity checks (impossible jumps, two machines uploading identical history) and holds uploads that fail them, but the leaderboard is self-reported usage, not a figure from Anthropic or OpenAI.
- Models outside the connector's list of name patterns are not counted until a release adds them.
- History deleted before Claude Code or Codex recorded a summary of it cannot be recovered.

## Requirements and contact

- macOS or Linux, with Node.js 20 or newer (`node --version`).
- `curl` and `bash` for the one-line installer; `launchctl` (macOS) or `crontab` (Linux) for the schedule.
- A GitHub account to approve each machine.

Privacy questions, data access and deletion requests: [hello@thehourglass.ai](mailto:hello@thehourglass.ai). Our privacy policy is at [thehourglass.ai/privacy](https://thehourglass.ai/privacy).
