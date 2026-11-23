#!/usr/bin/env node
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  lstat,
  rename,
  unlink,
  rmdir,
  open,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomUUID, createHash, createPublicKey, verify } from "node:crypto";
import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverRoots, formatLocal, historyTip, scan } from "./connect.mjs";
const SITE = "https://thehourglass.ai";
const LABEL = "ai.thehourglass.token-club";
// Must match connectorVersion in connect.mjs and release.json (tested).
export const VERSION = "0.2.9";
// The ed25519 key every release.json must be signed with: base64 of the SPKI DER public key
// (what `node scripts/token-club-release.mjs keygen` prints). Pinned from 0.2.4: every release
// needs a release.sig, or updates are refused. (An empty value would fall back to the SHA-256 manifest alone.)
export const RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEAi0VwqTrl++gyWx7Q3DoieudIpPlQR0b0yuQ3dal+OZk=";
export const stateDirectory = () =>
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Hourglass Token Club")
    : join(
        process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
        "hourglass-token-club",
      );
async function save(path, value) {
  const temporary = path + "." + randomUUID();
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
// History folders found by discovery, and whether each is counted: yes (counted, the
// default for every folder that passes the structure check, from 0.2.8) or no (turned
// off with --review, never counted again). Local only, owner-only, never uploaded. The
// walk runs at install, on --review and at most once a week during sync. 0.2.7 kept a
// third answer, pending, for folders nobody had answered; it now reads as yes.
const WEEK = 7 * 24 * 60 * 60 * 1000;
const ANSWERS = ["yes", "no"];
export async function loadRoots(directory) {
  const path = join(directory, "roots.json");
  const empty = { lastWalk: null, wsl: null, roots: {} };
  let state;
  try {
    if ((await lstat(path)).isSymbolicLink()) return empty;
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return empty;
  }
  const roots = {};
  for (const [root, value] of Object.entries(state?.roots ?? {}))
    if (["claude", "codex"].includes(value?.provider) && [...ANSWERS, "pending"].includes(value?.answer))
      roots[root] = { provider: value.provider, answer: value.answer === "no" ? "no" : "yes" };
  return {
    lastWalk: typeof state?.lastWalk === "string" ? state.lastWalk : null,
    // The WSL answer is whether to look in the Windows user folders at all.
    wsl: ["yes", "no", "pending"].includes(state?.wsl) ? state.wsl : null,
    roots,
  };
}
export const saveRoots = (directory, state) => save(join(directory, "roots.json"), state);
// A terminal to ask on: stdin when it is one, else the controlling terminal (curl | bash
// pipes stdin). None at all (cron, launchd, no terminal) means never prompt.
function terminal() {
  if (process.stdin.isTTY && process.stdout.isTTY) return { input: process.stdin, output: process.stdout, close() { this.lines?.return(); } };
  try {
    const fd = openSync("/dev/tty", "r+");
    const input = new ReadStream(fd),
      output = new WriteStream(fd);
    return {
      input,
      output,
      close() {
        this.lines?.return();
        input.destroy();
      },
    };
  } catch {
    return null;
  }
}
// One line reader per terminal session, so answers typed (or pasted) ahead are kept in
// order for the questions that follow.
async function ask(tty, question) {
  tty.lines ??= createInterface({ input: tty.input, terminal: false })[Symbol.asyncIterator]();
  tty.output.write(question);
  const { value, done } = await tty.lines.next();
  return done ? "" : value.trim();
}
const label = { claude: "Claude", codex: "Codex" };
// Walks (when due) and counts every folder found in the home folder that passes the
// structure check: no prompt about them, on a terminal or not. Windows user folders on
// WSL are the one exception: they can belong to another Windows user, so each is counted
// only after a yes on a terminal. One not yet answered is not stored, never counted, and
// asked about on the next terminal run. Returns the folders added this run.
export async function discover(directory, state, { walk, interactive, find = discoverRoots, openTerminal = terminal }) {
  let hits;
  const added = [];
  let windows = [];
  const add = (root, answer = "yes") => {
    if (state.roots[root.path]) return;
    state.roots[root.path] = { provider: root.provider, answer };
    if (answer === "yes") added.push([root.path, state.roots[root.path]]);
  };
  if (walk) {
    const result = await find({ includeWindows: state.wsl === "yes" });
    for (const root of result.found) add(root);
    windows = result.windows;
    if (result.wsl && !state.wsl) state.wsl = "pending";
    state.lastWalk = new Date().toISOString();
    hits = result;
  }
  const unanswered = () => windows.filter((root) => !state.roots[root.path]);
  const tty = interactive && (state.wsl === "pending" || unanswered().length) ? openTerminal() : null;
  if (tty) {
    try {
      if (state.wsl === "pending") {
        state.wsl = /^y(es)?$/i.test(await ask(tty, "This is WSL. Also look for Claude and Codex history in your Windows user folders (/mnt/c/Users)? [y/N] "))
          ? "yes"
          : "no";
        if (state.wsl === "yes") windows = (await find({ includeWindows: true })).windows;
      }
      for (const root of unanswered()) {
        const yes = /^y(es)?$/i.test(await ask(tty, `Count ${label[root.provider]}: ${root.path}? It may belong to another Windows user. [y/N] `));
        add(root, yes ? "yes" : "no");
      }
    } finally {
      tty.close();
    }
  }
  await saveRoots(directory, state);
  return { hits, added, windows: unanswered().length };
}
// --review on a terminal: each folder, Enter keeps its current setting.
async function review(state) {
  const tty = terminal();
  if (!tty) return false;
  try {
    for (const [path, value] of Object.entries(state.roots)) {
      const answer = await ask(tty, `Count ${label[value.provider]}: ${path}? [${value.answer === "yes" ? "Y/n" : "y/N"}] `);
      if (/^y(es)?$/i.test(answer)) value.answer = "yes";
      else if (/^no?$/i.test(answer)) value.answer = "no";
    }
  } finally {
    tty.close();
  }
  return true;
}
function addedLines(added, directory) {
  if (!added.length) return "";
  const counts = ["claude", "codex"]
    .map((p) => [added.filter(([, v]) => v.provider === p).length, label[p]])
    .filter(([count]) => count)
    .map(([count, name]) => count + " " + name);
  return (
    `Found ${added.length} more history folder${added.length === 1 ? "" : "s"}, now counted: ${counts.join(", ")}.\n` +
    added.map(([path, v]) => `  ${label[v.provider]}: ${path}\n`).join("") +
    `Totals only are uploaded, never paths. To stop counting one, run: node ${shellQuote(join(directory, "connect.mjs"))} --review`
  );
}
async function api(path, body, credential) {
  const response = await fetch(SITE + "/api/token-club/" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 410
        ? "revoked"
        : ["sync_too_soon", "duplicate_machine", "impossible_usage"].includes(
              data.error,
            )
          ? data.error
          : "server_unavailable",
    );
  return data;
}
const run = (command, args, input) =>
  execFileSync(command, args, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 15000,
  });
const shellQuote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const xml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function cronLines() {
  try {
    return run("crontab", ["-l"]);
  } catch (error) {
    if (error.status === 1) return "";
    throw new Error("scheduler_unavailable");
  }
}
async function schedule(directory, remove = false) {
  if (platform() === "darwin") {
    const path = join(homedir(), "Library/LaunchAgents", LABEL + ".plist");
    if (remove) {
      try {
        run("launchctl", ["bootout", "gui/" + process.getuid(), path]);
      } catch {}
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(directory, "sync.mjs"))}</string><string>--background</string></array><key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><false/></dict></plist>`,
      { mode: 0o600 },
    );
    try {
      run("launchctl", ["bootout", "gui/" + process.getuid(), path]);
    } catch {}
    run("launchctl", ["bootstrap", "gui/" + process.getuid(), path]);
  } else if (platform() === "linux") {
    // Keep every unrelated crontab entry exactly as it was.
    const previous = cronLines();
    const lines = previous
      .split("\n")
      .filter((line) => !line.endsWith(" # " + LABEL));
    if (!remove)
      lines.push(
        `*/15 * * * * ${shellQuote(process.execPath)} ${shellQuote(join(directory, "sync.mjs"))} --background >/dev/null 2>&1 # ${LABEL}`,
      );
    run("crontab", ["-"], lines.filter(Boolean).join("\n") + "\n");
  } else throw new Error("unsupported_platform");
}
// Updates itself (Finlay, 11 Nov 2026): each background sync reads release.json and,
// when the published version differs from this one, downloads both scripts, checks
// each SHA-256 against the manifest and swaps them in. The new code runs from the
// next sync. With RELEASE_PUBLIC_KEY pinned, release.json must also carry a valid
// release.sig line (update_unsigned otherwise). Any failure leaves the installed files untouched and the sync goes on.
// connect.mjs is swapped first and sync.mjs, which holds the version, last, so an
// interrupted swap is retried on the next run (old sync.mjs runs with new connect.mjs).
export async function selfUpdate(directory, { site = SITE, current = VERSION, get = fetch, publicKey = RELEASE_PUBLIC_KEY } = {}) {
  const download = async (file) => {
    const response = await get(`${site}/billion-token-club/${file}`, { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw new Error("update_unavailable");
    return Buffer.from(await response.arrayBuffer());
  };
  const manifest = await download("release.json");
  if (publicKey) {
    // Pinned key: release.sig must be a valid ed25519 signature over these exact bytes.
    // release.sig holds one base64 signature per line (a key rotation signs with old and new keys);
    // any line that verifies against the pinned key is enough.
    let signed = false;
    try {
      const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
      const lines = (await download("release.sig")).toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      signed = lines.some((line) => verify(null, manifest, key, Buffer.from(line, "base64")));
    } catch {}
    if (!signed) throw new Error("update_unsigned");
  }
  const release = JSON.parse(manifest.toString("utf8"));
  if (typeof release.version !== "string" || !/^0\.\d+\.\d+$/.test(release.version)) throw new Error("update_invalid");
  if (release.version === current) return "current";
  const files = {};
  for (const file of ["connect.mjs", "sync.mjs"]) {
    files[file] = await download(file);
    if (createHash("sha256").update(files[file]).digest("hex") !== release.sha256?.[file]) throw new Error("update_mismatch");
  }
  for (const file of ["connect.mjs", "sync.mjs"]) {
    const temporary = join(directory, file + "." + randomUUID());
    await writeFile(temporary, files[file], { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, file));
  }
  return "updated";
}
async function approve(config, path) {
  const pending = await api("pair/start", {
    installationId: config.installationId,
  });
  console.log(
    "Approve this machine: " +
      pending.verificationUri +
      "\nGitHub sign-in opens in your browser. On a VPS, open the link on your phone.",
  );
  if (
    platform() === "darwin" ||
    process.env.DISPLAY ||
    process.env.WAYLAND_DISPLAY
  ) {
    const child = spawn(
      platform() === "darwin" ? "open" : "xdg-open",
      [pending.authUri],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  }
  const until = Date.now() + 600000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const result = await api("pair/poll", { deviceCode: pending.deviceCode });
    if (result.machineId) {
      config.credential = pending.deviceCode;
      config.machineId = result.machineId;
      await save(path, config);
      return;
    }
    if (result.error) throw new Error("approval_expired");
  }
  throw new Error("approval_expired");
}
async function perform(args) {
  if (
    args.some(
      (arg) =>
        ![
          "--install",
          "--uninstall",
          "--json",
          "--background",
          "--review",
          "--help",
        ].includes(arg),
    ) ||
    args.filter((a) => a !== "--json").length > 1
  )
    throw new Error("invalid_arguments");
  if (args.includes("--help")) {
    console.log(
      "Token Club: --install, --uninstall, --review, --json. Syncs aggregate local usage every 15 minutes; never uploads prompts or files. --review lists the history folders found on this machine (all counted) and lets you turn one off.",
    );
    return;
  }
  const directory = dirname(fileURLToPath(import.meta.url));
  if (!(await lstat(directory)).isDirectory()) throw new Error("run_installer");
  const path = join(directory, "config.json");
  let config;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("invalid_config");
    config = JSON.parse(await readFile(path, "utf8"));
    if (
      !/^[a-f0-9-]{36}$/.test(config.installationId) ||
      (config.credential && !/^[A-Za-z0-9_-]{43}$/.test(config.credential))
    )
      throw new Error("invalid_config");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (args.includes("--uninstall") || args.includes("--review")) throw new Error("run_installer");
    config = {
      installationId: randomUUID(),
      installDirectory:
        resolve(directory) === resolve(stateDirectory())
          ? directory
          : undefined,
    };
  }
  if (
    resolve(directory) !== resolve(stateDirectory()) &&
    config.installDirectory !== directory
  )
    throw new Error("run_installer");
  if (args.includes("--uninstall")) {
    // Revoke first, so an offline removal cannot silently leave a valid credential behind.
    if (config.credential) await api("uninstall", {}, config.credential);
    await schedule(directory, true);
    for (const file of [
      "config.json",
      "connect.mjs",
      "sync.mjs",
      "last-sync.json",
      "roots.json",
      "sync.lock",
    ])
      await unlink(join(directory, file)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rmdir(directory).catch((error) => {
      if (error.code !== "ENOTEMPTY") throw error;
    });
    console.log(
      "Token Club removed. This machine no longer contributes tokens.",
    );
    return;
  }
  await chmod(directory, 0o700);
  const roots = await loadRoots(directory);
  if (args.includes("--review")) {
    await discover(directory, roots, { walk: true, interactive: true });
    const asked = Object.keys(roots.roots).length ? await review(roots) : false;
    if (asked) await saveRoots(directory, roots);
    const answered = Object.entries(roots.roots);
    if (!answered.length) console.log("No other Claude or Codex history folders found.");
    for (const [path, value] of answered)
      console.log(`${label[value.provider]}: ${path} (${value.answer === "yes" ? "counted" : "not counted"})`);
    if (answered.length && !asked) console.log(`To turn one off, run this in a terminal: node ${shellQuote(join(directory, "connect.mjs"))} --review`);
    return;
  }
  if (!config.credential) {
    if (!args.includes("--install")) throw new Error("approval_required");
    await approve(config, path);
  }
  if (args.includes("--install")) {
    config.roots = {
      ...config.roots,
      ...Object.fromEntries(
        ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
    };
    await save(path, config);
    await schedule(directory);
  }
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"])
    if (typeof config.roots?.[key] === "string")
      process.env[key] = config.roots[key];
  const update = args.includes("--background")
    ? await selfUpdate(directory).catch((error) => error.message.startsWith("update_") ? error.message : "update_failed")
    : undefined;
  const found = await discover(directory, roots, {
    walk: args.includes("--install") || !roots.lastWalk || !(Date.now() - Date.parse(roots.lastWalk) < WEEK),
    interactive: args.includes("--install"),
  });
  const extraRoots = Object.entries(roots.roots)
    .filter(([, value]) => value.answer === "yes")
    .map(([path, value]) => ({ path, provider: value.provider }));
  // Only `data` is uploaded; `local` (coverage, totals, warnings) stays on this machine.
  const { data, local } = await scan({ extraRoots });
  if (data.status === "error") throw new Error("no_usable_usage");
  let result;
  try {
    result = await api("sync", data, config.credential);
  } catch (error) {
    if (error.message !== "revoked") throw error;
    await schedule(directory, true);
    if (!args.includes("--install")) throw error;
    delete config.credential;
    await approve(config, path);
    await schedule(directory);
    result = await api("sync", data, config.credential);
  }
  await save(join(directory, "last-sync.json"), {
    at: new Date().toISOString(),
    status: data.status,
    diagnostics: data.diagnostics,
    update,
    // Local log: counts only, never a path.
    local: {
      roots: { claude: extraRoots.filter((x) => x.provider === "claude").length, codex: extraRoots.filter((x) => x.provider === "codex").length },
      added: found.added.length,
      backfill: { claude: local.backfill.claude, codex: local.backfill.codex, codes: local.backfill.codes },
      limits: found.hits?.limits,
      warnings: local.warnings.length,
    },
  });
  if (args.includes("--background")) return;
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({
        ...result,
        coverage: data.coverage,
        status: data.status,
        diagnostics: data.diagnostics,
      }),
    );
    return;
  }
  const n = (value) => Number(value || 0).toLocaleString("en-AU");
  console.log(
    `${result.displayName}: ${n(result.total)} tokens, rank ${result.rank ?? "pending"}.\nClaude ${n(result.claude)} | Codex ${n(result.codex)}${data.status === "partial" ? " | partial local history" : ""}\n${SITE}/billion-token-club`,
  );
  console.log(formatLocal(local));
  if (found.hits?.limits?.entries || found.hits?.limits?.time)
    console.log("The search for history folders stopped at its " + (found.hits.limits.time ? "time" : "size") + " limit; some folders were not checked.");
  if (found.added.length) console.log(addedLines(found.added, directory));
  if (roots.wsl === "pending" || found.windows)
    console.log(`This is WSL. To choose which Windows user folders to count, run this in a terminal: node ${shellQuote(join(directory, "connect.mjs"))} --review`);
  const tip = await historyTip();
  if (tip) console.log(tip);
}
const MESSAGES = {
  revoked:
    "This machine was removed. Run the install command to approve it again.",
  approval_expired: "Approval expired. Run the install command again.",
  approval_required:
    "Approve this machine by running the install command first.",
  scheduler_unavailable:
    "Background sync could not be installed. Check that cron or launchd is available.",
  unsupported_platform: "This connector supports Mac and Linux.",
  run_installer: "Use the install command from the Token Club page.",
  invalid_arguments: "Invalid arguments. Use --help for supported options.",
  no_usable_usage:
    "No usable Claude Code or Codex history was found. Check the configured log roots.",
  sync_too_soon:
    "This machine synced recently. Wait 30 seconds before trying again.",
  duplicate_machine:
    "This history matches another approved machine. Check My machines.",
  impossible_usage: "Automatic checks held this upload. Check My machines.",
  sync_running: "A sync is already running. Wait for it to finish.",
  server_unavailable: "The service is unavailable. Try again shortly.",
};
export const explain = (error) =>
  MESSAGES[error?.message] || "Sync failed. Run the install command again or check My machines.";
export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) return perform(args);
  const directory = dirname(fileURLToPath(import.meta.url));
  const lock = join(directory, "sync.lock");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lock, "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("sync_running");
    try {
      process.kill(pid, 0);
      if (args.includes("--background")) return;
      throw new Error("sync_running");
    } catch (active) {
      if (active.code !== "ESRCH") throw active;
    }
    await unlink(lock);
    handle = await open(lock, "wx", 0o600);
  }
  try {
    await handle.writeFile(String(process.pid));
    await handle.close();
    await perform(args);
  } finally {
    await handle.close().catch(() => {});
    await unlink(lock).catch(() => {});
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error("Token Club: " + explain(error));
    process.exitCode = 1;
  });
