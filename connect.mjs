#!/usr/bin/env node
// Local aggregate export only. Log bytes are read locally; nothing is uploaded.
import { constants } from "node:fs";
import { lstat, opendir, open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_LINE = 32 * 1024 * 1024;
const COUNTERS = ["input", "output", "cacheRead", "cacheCreation", "reasoning"];
const safe = (n) => Number.isSafeInteger(n) && n >= 0;
const sum = (values) => {
  const n = values.reduce((a, b) => a + b, 0);
  if (!safe(n)) throw new Error("unsafe_total");
  return n;
};
function dayOf(timestamp) {
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
  )
    throw new Error("invalid_date");
  const local = timestamp.slice(0, 10);
  const localDate = new Date(local);
  if (!Number.isFinite(localDate.getTime()) || localDate.toISOString().slice(0, 10) !== local)
    throw new Error("invalid_date");
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_date");
  return date.toISOString().slice(0, 10);
}
function modelOf(value, provider) {
  if (provider === "claude" && typeof value === "string" && /^(sonnet|opus|haiku|fable)-/.test(value))
    value = "claude-" + value;
  const pattern =
    provider === "claude"
      ? /^claude-(?:(?:sonnet|opus|haiku|fable)-\d+(?:[-.]\d+)*(?:-\d{8})?|\d+(?:-\d+)*-(?:sonnet|opus|haiku)(?:-\d{8})?)$/
      : /^(?:gpt-\d+(?:\.\d+)?(?:-codex)?(?:-(?:mini|max|nano|sol|astra|terra|luna))?|o[134](?:-mini)?|codex-mini-latest)$/;
  if (typeof value !== "string" || value.length > 64 || !pattern.test(value)) throw new Error("unsupported_model");
  return value;
}
function identity(value) {
  if (typeof value !== "string" || !value.length || value.length > 256) throw new Error("missing_identity");
  return value;
}
function counters(u, provider) {
  if (!u || typeof u !== "object") throw new Error("unsupported_usage");
  const c = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: provider === "claude" ? u.cache_read_input_tokens : (u.cached_input_tokens ?? 0),
    cacheCreation: provider === "claude" ? u.cache_creation_input_tokens : (u.cache_write_input_tokens ?? 0),
    reasoning: provider === "codex" ? (u.reasoning_output_tokens ?? 0) : 0,
  };
  if (!Object.values(c).every(safe)) throw new Error("invalid_counter");
  if (provider === "codex" && (c.cacheRead + c.cacheCreation > c.input || c.reasoning > c.output))
    throw new Error("invalid_subset");
  const total = sum(provider === "claude" ? [c.input, c.output, c.cacheRead, c.cacheCreation] : [c.input, c.output]);
  if (u.total_tokens !== undefined && (!safe(u.total_tokens) || u.total_tokens !== total))
    throw new Error("inconsistent_total");
  return { ...c, total };
}

// Known roots (signed with this file). Each new storage location reaches members as a
// signed release. Sources: Claude Code and Codex defaults, ccusage and tokscale path lists.
//   Claude Code: CLAUDE_CONFIG_DIR (comma list) or ~/.claude and $XDG_CONFIG_HOME/claude
//     (default ~/.config/claude), each with projects/ and transcripts/; cc-mirror
//     ~/.cc-mirror/<variant>/config/projects.
//   Claude desktop app (Cowork and Claude Code inside the app): .claude/projects and
//     .claude/transcripts at any depth under local-agent-mode-sessions and
//     claude-code-sessions, in ~/Library/Application Support/Claude (macOS),
//     %APPDATA%/Claude (Windows) or $XDG_CONFIG_HOME/Claude (Linux). audit.jsonl is a
//     second copy of the same traffic and never counts.
//   Codex (CLI, IDE extension, desktop app): CODEX_HOME (comma list) or ~/.codex, each
//     with sessions/ and archived_sessions/.
export function knownRoots({ env = process.env, home = homedir(), platform = osPlatform() } = {}) {
  const list = (value) => value.split(",").map((x) => x.trim());
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const claudeExplicit = env.CLAUDE_CONFIG_DIR !== undefined,
    codexExplicit = env.CODEX_HOME !== undefined;
  const claudeHomes = claudeExplicit ? list(env.CLAUDE_CONFIG_DIR) : [join(home, ".claude"), join(config, "claude")];
  const codexHomes = codexExplicit ? list(env.CODEX_HOME) : [join(home, ".codex")];
  const app =
    platform === "darwin"
      ? join(home, "Library/Application Support/Claude")
      : platform === "win32"
        ? join(env.APPDATA || join(home, "AppData/Roaming"), "Claude")
        : join(config, "Claude");
  return {
    claudeExplicit,
    codexExplicit,
    invalid: [...claudeHomes, ...codexHomes].some((x) => !x),
    claudeHomes,
    codexHomes,
    ccMirror: join(home, ".cc-mirror"),
    desktop: ["local-agent-mode-sessions", "claude-code-sessions"].map((name) => join(app, name)),
  };
}
async function childDirectories(path) {
  const out = [];
  try {
    for await (const entry of await opendir(path)) if (entry.isDirectory()) out.push(join(path, entry.name));
  } catch {}
  return out.sort();
}
const DESKTOP_WARNING = "A Claude desktop history folder could not be read, so its tokens are not counted.";
// Every .claude/projects and .claude/transcripts folder under a desktop sessions folder,
// at any depth, never through a link (a tree without links has no cycle, so this ends).
// An unreadable folder is a local warning only (no path, no upload diagnostic).
async function desktopRoots(path, local, depth = 0) {
  const roots = [];
  let directory;
  try {
    directory = await opendir(path);
  } catch (e) {
    if (!(depth === 0 && e.code === "ENOENT") && !local.warnings.includes(DESKTOP_WARNING))
      local.warnings.push(DESKTOP_WARNING);
    return roots;
  }
  const names = [];
  for await (const entry of directory) if (entry.isDirectory()) names.push(entry.name);
  for (const name of names.sort()) {
    const child = join(path, name);
    if (name === ".claude") {
      for (const sub of ["projects", "transcripts"])
        if (await lstat(join(child, sub)).then((st) => st.isDirectory(), () => false)) roots.push(join(child, sub));
    } else roots.push(...(await desktopRoots(child, local, depth + 1)));
  }
  return roots;
}

// Discovery: a bounded, name-only walk of the home folder for history folders the
// known roots miss (for example ~/.claude-ai-cadence or ~/.codex-personal).
export const WALK_LIMITS = Object.freeze({ depth: 6, entries: 200000, ms: 10000 });
export const HEAD_BYTES = 64 * 1024;
export const HEAD_LINES = 5;
const SKIP_NAMES = new Set(["node_modules", ".git", ".cache", "Pictures", "Movies", "Music", ".Trash", ".npm", ".cargo", ".rustup", ".venv", "venv", "site-packages"]);
const SKIP_PATHS = new Set(["Library/Caches", "Library/Mail", "Library/Messages", "Library/Photos", "go/pkg", ".local/share/Trash"]);
export function skipped(rel) {
  const parts = rel.split("/");
  if (SKIP_NAMES.has(parts.at(-1)) || SKIP_PATHS.has(rel)) return true;
  // Library/Containers is skipped except Claude's own containers.
  return parts.length === 3 && parts[0] === "Library" && parts[1] === "Containers" && !/claude/i.test(parts[2]);
}
const realIo = { lstat, opendir, open, readFile };
/**
 * Structure check, the only file read: opens one file read-only, reads at most
 * HEAD_BYTES once and parses at most HEAD_LINES lines, accepting by keys only. The
 * bytes are discarded; nothing from them is kept or logged.
 */
export async function structureCheck(path, provider, io = realIo, dev) {
  let handle;
  try {
    // A file on another device is never opened (the walk checks before calling), and is
    // refused here as well if it changed underneath.
    if (dev !== undefined && (await io.lstat(path)).dev !== dev) return false;
    handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || (dev !== undefined && st.dev !== dev)) return false;
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const rows = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")
      .slice(0, HEAD_LINES)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
    buffer.fill(0);
    if (provider === "codex") return rows[0]?.type === "session_meta" && typeof rows[0]?.payload?.id === "string";
    return rows.some((row) => ["user", "assistant", "summary"].includes(row?.type) && typeof row?.sessionId === "string");
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
/**
 * Walks `home` by directory names only: no links followed, never off the home folder's
 * device, depth, entry and time limits, the skip list, and known roots left alone.
 * Returns candidate roots (provider and path) that pass the structure check, which
 * limits were hit, and whether this is WSL. Nothing here is uploaded.
 */
export async function discoverRoots({
  env = process.env,
  home = homedir(),
  platform = osPlatform(),
  limits = WALK_LIMITS,
  now = Date.now,
  io = realIo,
  includeWindows = false,
  windowsUsers = "/mnt/c/Users",
} = {}) {
  const started = now();
  const hits = { depth: false, entries: false, time: false };
  let entries = 0;
  const known = knownRoots({ env, home, platform });
  const skip = new Set(
    [...known.claudeHomes, ...known.codexHomes, known.ccMirror, ...known.desktop.map((x) => join(x, ".."))].map((x) => resolve(x)),
  );
  const over = () => {
    if (entries > limits.entries) hits.entries = true;
    else if (now() - started > limits.ms) hits.time = true;
    return hits.entries || hits.time;
  };
  // Lists one directory (names and types only), counting every entry against the limit.
  // A directory that is a link, or on another device than `dev`, is never opened.
  async function list(path, dev) {
    const names = [];
    // Once a limit is hit, nothing more is opened.
    if (over()) return names;
    try {
      const st = await io.lstat(path);
      if (!st.isDirectory() || st.dev !== dev) return names;
      for await (const entry of await io.opendir(path)) {
        entries++;
        if (over()) break;
        names.push({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() });
      }
    } catch {}
    return names;
  }
  const dirs = (names) => names.filter((x) => x.dir).map((x) => x.name).sort();
  // The newest file by mtime across every path given (no subset), same device only.
  // The walk's entry and time limits bound it; a hit is reported in local output.
  async function newest(paths, dev) {
    let best;
    for (const path of paths) {
      if (over()) break;
      const st = await io.lstat(path).catch(() => null);
      if (st?.isFile() && st.dev === dev && (!best || st.mtimeMs > best.time)) best = { path, time: st.mtimeMs };
    }
    return best?.path;
  }
  // Recognises a store by layout, then confirms one newest file by its keys.
  async function store(path, names, dev) {
    const has = (name) => names.some((x) => x.dir && x.name === name);
    if (has("projects") || (basename(path) === ".claude" && has("transcripts"))) {
      const files = [];
      if (has("projects"))
        for (const sub of dirs(await list(join(path, "projects"), dev))) {
          if (over()) break;
          for (const x of await list(join(path, "projects", sub), dev)) if (x.file && x.name.endsWith(".jsonl")) files.push(join(path, "projects", sub, x.name));
        }
      if (has("transcripts"))
        for (const x of await list(join(path, "transcripts"), dev)) if (x.file && x.name.endsWith(".jsonl")) files.push(join(path, "transcripts", x.name));
      const file = await newest(files.filter((x) => basename(x) !== "audit.jsonl"), dev);
      if (file && (await structureCheck(file, "claude", io, dev))) return "claude";
    }
    if (has("sessions")) {
      // Every sessions/YYYY/MM/DD folder, so the newest file is found by mtime, not by folder name.
      let level = [join(path, "sessions")];
      for (const pattern of [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/]) {
        const next = [];
        for (const at of level) for (const name of dirs(await list(at, dev))) if (pattern.test(name)) next.push(join(at, name));
        level = next;
      }
      const files = [];
      for (const at of level)
        for (const x of await list(at, dev)) if (x.file && /^rollout-.*\.jsonl$/.test(x.name)) files.push(join(at, x.name));
      const file = await newest(files, dev);
      if (file && (await structureCheck(file, "codex", io, dev))) return "codex";
    }
    return null;
  }
  const found = [];
  const root = await io.lstat(home).catch(() => null);
  if (root?.isDirectory()) {
    const queue = [{ path: resolve(home), depth: 0, rel: "" }];
    for (let at = 0; at < queue.length && !over(); at++) {
      const { path, depth, rel } = queue[at];
      const names = await list(path, root.dev);
      const provider = depth > 0 ? await store(path, names, root.dev) : null;
      if (provider) {
        found.push({ provider, path });
        continue;
      }
      for (const name of dirs(names)) {
        if (over()) break;
        const childRel = rel ? rel + "/" + name : name,
          child = join(path, name);
        if (skipped(childRel) || skip.has(child)) continue;
        if (depth + 1 > limits.depth) {
          hits.depth = true;
          continue;
        }
        const st = await io.lstat(child).catch(() => null);
        // lstat never follows a link; a different device is another disk or a network mount.
        if (!st?.isDirectory() || st.dev !== root.dev) continue;
        queue.push({ path: child, depth: depth + 1, rel: childRel });
      }
    }
  }
  // WSL: the Windows user folders, exactly one level, only after the member said yes.
  // System profiles are skipped; each folder found is still asked about by path.
  let wsl = false;
  if (platform === "linux") wsl = /microsoft/i.test(await io.readFile("/proc/version", "utf8").catch(() => ""));
  const windows = [];
  // /mnt/c is its own device by design: everything under it must share that device.
  const drive = wsl && includeWindows ? await io.lstat(windowsUsers).catch(() => null) : null;
  if (drive?.isDirectory())
    for (const user of dirs(await list(windowsUsers, drive.dev)).filter((x) => !["All Users", "Default", "Default User", "Public"].includes(x)))
      for (const name of [".claude", ".codex"]) {
        const path = join(windowsUsers, user, name);
        const provider = await store(path, await list(path, drive.dev), drive.dev);
        if (provider) windows.push({ provider, path });
      }
  return { found, windows, wsl, limits: hits, entries };
}

/** The Claude Code history tip: read-only, never edits the member's settings. */
export async function historyTip(home = homedir()) {
  let days;
  try {
    days = JSON.parse(await readFile(join(home, ".claude/settings.json"), "utf8"))?.cleanupPeriodDays;
  } catch (e) {
    if (e.code !== "ENOENT") return null;
  }
  if (typeof days === "number" && days >= 365) return null;
  const kept = typeof days === "number" ? days + " days" : "30 days (the default)";
  return `History tip: Claude Code deletes history older than ${kept}, and deleted history cannot be recovered. Set "cleanupPeriodDays": 3650 in ~/.claude/settings.json to keep it.`;
}

// Deleted-history backfill (0.2.8). Claude Code deletes transcripts after
// cleanupPeriodDays (30 by default) but keeps a daily per-model token summary in
// <config dir>/stats-cache.json (what /stats shows: {version, dailyModelTokens: [{date,
// tokensByModel: {model: tokens}}]}, tokens = input + output + cache reads + cache
// writes). Codex keeps one tokens_used total per thread in $CODEX_HOME/state_<n>.sqlite
// after a rollout file is gone. Claude (0.2.9): per day and model, the larger of the
// transcripts and the summary, so a day whose transcripts were partly deleted still
// counts in full; never their sum, so nothing counts twice. Codex fills only days this
// machine's own logs have no usage for (gap days).
// Every problem leaves a fixed local code (never uploaded) and adds nothing; log
// counting never depends on these files.
export const SUMMARY_MAX = 8 * 1024 * 1024;
// Claude Code's own reader accepts stats-cache versions 1 to 5.
const SUMMARY_VERSIONS = [1, 2, 3, 4, 5];
// The server refuses days before this, so a row older than it would sink the whole upload.
const FIRST_DAY = "2025-01-01";
// The per-row plausibility bound the upload validator applies (total <= requests x 20M).
const ROW_BOUND = 20000000;
// A backfill problem: a fixed local code, never an upload diagnostic.
class Skip {
  constructor(code) {
    this.code = code;
  }
}
function backfillDay(value, today) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Skip("bad_date");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Skip("bad_date");
  if (value > today) throw new Skip("future_date");
  if (value < FIRST_DAY) throw new Skip("old_date");
  return value;
}
/** Reads one file, owner checks aside: no link, a regular file, at most `max` bytes. */
async function readBounded(path, max) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Skip("unreadable");
    if (st.size > max) throw new Skip("too_large");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > max) throw new Skip("too_large");
    }
    return { text: buffer.subarray(0, length).toString("utf8"), key: st.dev + ":" + st.ino };
  } finally {
    await handle.close().catch(() => {});
  }
}
/**
 * Claude Code's daily summary for one config dir: Map day -> Map model -> tokens, or null.
 * `code` records a fixed local code for anything it cannot use.
 */
export async function readClaudeSummary(dir, code, { today = new Date().toISOString().slice(0, 10), seen = new Set(), missing = true } = {}) {
  let file;
  try {
    file = await readBounded(join(dir, "stats-cache.json"), SUMMARY_MAX);
  } catch (e) {
    if (e.code === "ENOENT") {
      if (missing && (await lstat(join(dir, "projects")).then((st) => st.isDirectory(), () => false))) code("summary_missing");
    } else code(e instanceof Skip && e.code === "too_large" ? "summary_too_large" : "summary_unreadable");
    return null;
  }
  if (seen.has(file.key)) return null;
  seen.add(file.key);
  let summary;
  try {
    summary = JSON.parse(file.text);
  } catch {
    code("summary_malformed");
    return null;
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    code("summary_malformed");
    return null;
  }
  if (!SUMMARY_VERSIONS.includes(summary.version)) {
    code("summary_version");
    return null;
  }
  if (!Array.isArray(summary.dailyModelTokens)) {
    code("summary_malformed");
    return null;
  }
  const days = new Map();
  for (const entry of summary.dailyModelTokens) {
    const models = entry?.tokensByModel;
    if (!entry || typeof entry !== "object" || !models || typeof models !== "object" || Array.isArray(models)) {
      code("summary_malformed");
      continue;
    }
    let day;
    try {
      day = backfillDay(entry.date, today);
    } catch (e) {
      code("summary_" + e.code);
      continue;
    }
    // Claude Code merges by date, so a repeated date is a damaged file: the first stands.
    if (days.has(day)) {
      code("summary_malformed");
      continue;
    }
    const row = new Map();
    for (const [name, tokens] of Object.entries(models)) {
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        code("summary_bad_count");
        continue;
      }
      let model;
      try {
        model = modelOf(name, "claude");
      } catch {
        code("summary_bad_model");
        continue;
      }
      if (!tokens) continue;
      const total = (row.get(model) ?? 0) + tokens;
      if (!Number.isSafeInteger(total)) {
        code("summary_bad_count");
        continue;
      }
      row.set(model, total);
    }
    days.set(day, row);
  }
  return days;
}
// node:sqlite ships with Node 22.13 and later; an older Node skips the thread backfill.
// Its one-time "experimental" notice is not printed, so a sync's output stays the same.
async function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/sqlite/i.test(String(warning?.message ?? warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}
const THREAD_COLUMNS = ["tokens_used", "model", "created_at", "rollout_path"];
/**
 * Codex's thread list for one Codex home: the highest-numbered state_<n>.sqlite, opened
 * read-only (a file: URI with mode=ro; never written, never checkpointed). Returns
 * [{ rollout, day, model, tokens }] for every usable thread, or null.
 */
export async function readCodexThreads(dir, code, { today = new Date().toISOString().slice(0, 10), seen = new Set(), sqlite = loadSqlite } = {}) {
  let best;
  try {
    for (const name of await readdir(dir)) {
      const m = /^state_(\d{1,9})\.sqlite$/.exec(name);
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), path: join(dir, name) };
    }
  } catch {
    return null;
  }
  if (!best) return null;
  const st = await lstat(best.path).catch(() => null);
  if (!st?.isFile()) {
    code("threads_unreadable");
    return null;
  }
  const key = st.dev + ":" + st.ino;
  if (seen.has(key)) return null;
  seen.add(key);
  const DatabaseSync = await sqlite();
  if (!DatabaseSync) {
    code("threads_no_sqlite");
    return null;
  }
  let db, rows;
  try {
    const url = pathToFileURL(best.path);
    url.search = "mode=ro";
    db = new DatabaseSync(url, { readOnly: true });
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((x) => x.name));
    if (!THREAD_COLUMNS.every((x) => columns.has(x))) {
      code("threads_no_table");
      return null;
    }
    rows = db.prepare("SELECT rollout_path, created_at, model, tokens_used FROM threads").all();
  } catch {
    code("threads_unreadable");
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
  const threads = [];
  for (const row of rows) {
    try {
      if (typeof row.rollout_path !== "string" || !row.rollout_path) throw new Skip("bad_row");
      if (!Number.isSafeInteger(row.tokens_used) || row.tokens_used < 0) throw new Skip("bad_count");
      if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Skip("bad_date");
      const date = new Date(row.created_at * 1000);
      if (!Number.isFinite(date.getTime())) throw new Skip("bad_date");
      const day = backfillDay(date.toISOString().slice(0, 10), today);
      if (!row.tokens_used) continue;
      let model;
      try {
        model = modelOf(row.model, "codex");
      } catch {
        throw new Skip("bad_model");
      }
      threads.push({ rollout: resolve(dir, row.rollout_path), day, model, tokens: row.tokens_used });
    } catch (e) {
      code(e instanceof Skip ? "threads_" + e.code : "threads_bad_row");
    }
  }
  return threads;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_LABELS = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude desktop app",
  "claude-other": "Other Claude folders",
  codex: "Codex",
  "codex-other": "Other Codex folders",
  "claude-summary": "Claude Code daily summary (deleted history)",
  "codex-summary": "Codex thread list (deleted history)",
};
/**
 * This machine's totals and, per root kind, for each of the last 6 months the tokens and
 * the transcript files holding at least one counted message that month (local output only).
 */
export function formatLocal(local, now = new Date()) {
  const n = (value) => value.toLocaleString("en-AU");
  const short = (value) => Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
  const lines = [
    `This machine: ${n(local.totals.claude + local.totals.codex)} tokens (Claude ${n(local.totals.claude)} | Codex ${n(local.totals.codex)}).`,
  ];
  for (const [kind, label] of Object.entries(KIND_LABELS)) {
    if (!local.files[kind]) continue;
    const cells = months.map((m) => {
      const key = m.toISOString().slice(0, 7);
      const files = local.fileMonths[kind]?.[key]?.size ?? 0;
      return `${MONTHS[m.getUTCMonth()]} ${short(local.months[kind]?.[key] ?? 0)} (${files} file${files === 1 ? "" : "s"})`;
    });
    lines.push(`${label} (${n(local.files[kind])} file${local.files[kind] === 1 ? "" : "s"}): ${cells.join(" | ")}`);
  }
  const codes = Object.entries(local.backfill?.codes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (codes.length) lines.push("Deleted-history summaries skipped: " + codes.map(([code, count]) => `${code} (${count})`).join(", ") + ".");
  return [...lines, ...local.warnings].join("\n");
}

/** The upload payload only. Does not echo paths, identifiers, arbitrary errors or record contents. */
export async function scanUsage(options) {
  return (await scan(options)).data;
}

/**
 * Scans every known root plus the extra roots the member accepted. Returns the upload
 * payload (`data`, the same shape as 0.2.5) and `local`: coverage by root kind and
 * month, this machine's totals and warnings. `local` is printed on this machine only
 * and never uploaded.
 */
export async function scan({ env = process.env, home = homedir(), platform = osPlatform(), extraRoots = [] } = {}) {
  // fileMonths: per kind and month, the files holding at least one counted message.
  const local = {
    files: {},
    months: {},
    fileMonths: {},
    totals: { claude: 0, codex: 0 },
    warnings: [],
    // Deleted-history backfill: gap days filled, and fixed local codes (never uploaded).
    backfill: { claude: 0, codex: 0, codes: {} },
  };
  let fileCount = 0;
  // A session teleported from another machine keeps that machine's messages, which
  // that machine already counts. Each message records its working folder, so count
  // only messages written here: skip Mac paths on Linux and Linux paths on a Mac.
  const otherMachine = platform === "darwin" ? /^\/home\// : /^\/Users\//;
  const diagnostics = new Map();
  let incomplete = false;
  const note = (provider, code, fatal = true) => {
    const key = provider + ":" + code;
    diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1);
    if (fatal) incomplete = true;
  };
  const claude = new Map(),
    rollouts = new Set(),
    responses = new Map(),
    codexFiles = [],
    seenFiles = new Set();
  const invalidClaude = new Set();
  function record(row, provider, state) {
    if (provider === "claude") {
      if (row?.type !== "assistant" || !row.message || !Object.hasOwn(row.message, "usage")) return;
      if (
        row.message.model === "<synthetic>" &&
        ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].every(
          (k) => (row.message.usage?.[k] ?? 0) === 0,
        )
      ) {
        note(provider, "synthetic_ignored", false);
        return;
      }
      if (typeof row.cwd === "string" && otherMachine.test(row.cwd)) {
        note(provider, "other_machine_ignored", false);
        return;
      }
      let key;
      try {
        key = identity(row.message.id);
        const day = dayOf(row.timestamp),
          model = modelOf(row.message.model, provider);
        const value = {
          day,
          model,
          time: new Date(row.timestamp).getTime(),
          kind: state.kind,
          file: state.file,
          ...counters(row.message.usage, provider),
        };
        const old = claude.get(key);
        if (!old) {
          claude.set(key, value);
          return;
        }
        if (old.model !== value.model) throw new Error("conflicting_duplicate");
        const earliestDay = old.day < day ? old.day : day;
        if (value.time > old.time) {
          claude.set(key, { ...value, day: earliestDay });
          return;
        }
        if (value.time < old.time) {
          old.day = earliestDay;
          return;
        }
        const grows = COUNTERS.every((k) => value[k] >= old[k]);
        const shrinks = COUNTERS.every((k) => value[k] <= old[k]);
        if (!grows && !shrinks) throw new Error("conflicting_duplicate");
        if (grows) claude.set(key, { ...value, day: earliestDay });
      } catch (e) {
        if (key) invalidClaude.add(key);
        note(provider, e.message);
      }
      return;
    }
    // Codex. A file is one session, named by its FIRST session_meta: a forked or
    // subagent rollout carries a copy of its parent's session_meta later on, and
    // that copy is not a session switch.
    if (row?.type === "session_meta") {
      if (state.session !== undefined) return;
      try {
        state.session = identity(row.payload?.id);
      } catch (e) {
        state.session = null;
        note(provider, e.message);
      }
    } else if (row?.type === "compacted") {
      state.compacted = true;
    } else if (row?.type === "turn_context") {
      try {
        state.model = modelOf(row.payload?.model, provider);
      } catch (e) {
        state.model = undefined;
        note(provider, e.message);
      }
    } else if (row?.type === "token_usage_record") {
      // One line per model response (Codex builds from September 2026), with that
      // response's own usage. Forks, resumes and subagents copy lines between files,
      // so each response id counts once, at its earliest timestamp.
      state.records = true;
      try {
        if (!state.session) throw new Error("missing_context");
        const key = identity(row.payload?.response_id);
        const usage = row.payload?.usage;
        const value = {
          day: dayOf(row.timestamp),
          time: new Date(row.timestamp).getTime(),
          model: state.model ?? null,
          kind: state.kind,
          file: state.file,
          ...counters(usage && { ...usage, total_tokens: undefined }, provider),
        };
        if (usage?.total_tokens !== undefined && usage.total_tokens !== value.total)
          note(provider, "native_total_mismatch");
        const old = responses.get(key);
        if (!old || value.time < old.time) {
          responses.set(key, { ...value, model: value.model ?? old?.model ?? null });
        } else if (old.model === null) old.model = value.model;
        else if (value.time === old.time && value.model !== null && value.model !== old.model) {
          note(provider, "ambiguous_snapshot");
          if (value.model < old.model) old.model = value.model;
        }
      } catch (e) {
        note(provider, e.message);
      }
    } else if (row?.type === "event_msg" && row.payload?.type === "token_count") {
      // Rate-limit-only events contain no usage and do not represent a request.
      // Once a file has records, its snapshots repeat what the records count.
      if (row.payload.info === null || state.records) return;
      try {
        if (!state.session) throw new Error(state.session === null ? "missing_context" : "missing_identity");
        if (!state.model) note(provider, "missing_context");
        const day = dayOf(row.timestamp),
          time = new Date(row.timestamp).getTime();
        const usage = row.payload.info?.total_token_usage;
        const value = {
          day,
          time,
          model: state.model ?? null,
          kind: state.kind,
          file: state.file,
          compacted: state.compacted === true,
          ...counters(usage && { ...usage, total_tokens: undefined }, provider),
        };
        if (usage?.total_tokens !== undefined && usage.total_tokens !== value.total)
          note(provider, "native_total_mismatch");
        const last = row.payload.info?.last_token_usage;
        if (last !== undefined && last !== null) value.last = counters({ ...last, total_tokens: undefined }, provider);
        state.compacted = false;
        state.snapshots.push(value);
      } catch (e) {
        note(provider, e.message);
      }
    }
  }
  async function readLog(path, provider, kind) {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await handle.stat();
      if (!st.isFile()) {
        note(provider, "nonregular_skipped");
        return;
      }
      const key = provider + ":" + st.dev + ":" + st.ino;
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
      local.files[kind] = (local.files[kind] ?? 0) + 1;
      const state = { snapshots: [], kind, file: fileCount++ };
      let parts = [],
        pendingSize = 0,
        oversized = false;
      const consume = (line) => {
        if (!line.length) return;
        let row;
        try {
          row = JSON.parse(line.toString("utf8"));
        } catch {
          note(provider, "malformed_json");
          return;
        }
        record(row, provider, state);
      };
      for await (const chunk of handle.createReadStream({
        highWaterMark: 64 * 1024,
        autoClose: false,
      })) {
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline === -1 ? chunk.length : newline;
          const part = chunk.subarray(start, end);
          if (!oversized && pendingSize + part.length > MAX_LINE) {
            note(provider, "line_too_large");
            oversized = true;
            parts = [];
            pendingSize = 0;
          }
          if (!oversized && part.length) {
            parts.push(part);
            pendingSize += part.length;
          }
          if (newline !== -1) {
            if (!oversized) consume(Buffer.concat(parts, pendingSize));
            oversized = false;
            parts = [];
            pendingSize = 0;
          }
          start = end + 1;
        }
      }
      if (!oversized) consume(Buffer.concat(parts, pendingSize));
      if (provider === "codex" && state.snapshots.length) codexFiles.push(state.snapshots);
    } catch (e) {
      note(provider, "unreadable_file");
    } finally {
      if (handle) await handle.close();
    }
  }
  async function collect(path, provider, root, found, depth = 0) {
    const explicit = root.explicit === true;
    if (depth > 64) {
      note(provider, "depth_limit");
      return;
    }
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      note(
        provider,
        e.code === "ENOENT" && depth === 0 && !explicit ? "missing_default_root" : "unreadable_root",
        !(e.code === "ENOENT" && depth === 0 && !explicit),
      );
      return;
    }
    if (depth === 0) {
      try {
        const canonical = await realpath(path);
        if (canonical !== resolve(path)) return collect(canonical, provider, root, found, 1);
      } catch {
        note(provider, "unreadable_root");
        return;
      }
    }
    if (st.isSymbolicLink()) {
      note(provider, "symlink_skipped");
      return;
    }
    if (st.isDirectory()) {
      try {
        const directory = await opendir(path, { bufferSize: 32 });
        for await (const entry of directory)
          await collect(join(path, entry.name), provider, root, found, depth + 1);
      } catch {
        note(provider, "unreadable_root");
      }
    } else if (st.isFile() && path.endsWith(".jsonl")) {
      // The Claude desktop app keeps a second copy of the same traffic in audit.jsonl.
      if (basename(path) !== "audit.jsonl") found.push({ path, modified: st.mtimeMs, kind: root.kind });
    } else if (depth === 0 || !st.isFile()) note(provider, "nonregular_skipped");
  }
  async function scanRoots(roots, provider) {
    const found = [];
    const seen = new Set();
    for (const root of roots) {
      if (seen.has(root.path)) continue;
      seen.add(root.path);
      // Optional roots (archived Codex threads, transcripts, accepted extra folders)
      // are read when present and are never a diagnostic when absent.
      if (root.optional && !(await lstat(root.path).then(() => true, () => false))) continue;
      await collect(root.path, provider, root, found);
    }
    found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    for (const file of found) {
      if (provider === "codex") rollouts.add(basename(file.path));
      await readLog(file.path, provider, file.kind);
    }
  }
  const known = knownRoots({ env, home, platform });
  const claudeRoots = [];
  for (const dir of known.claudeHomes) {
    claudeRoots.push({ path: join(dir, "projects"), kind: "claude-code", explicit: known.claudeExplicit });
    claudeRoots.push({ path: join(dir, "transcripts"), kind: "claude-code", optional: true });
  }
  // Additive: CLAUDE_CONFIG_DIR replaces only ~/.claude and $XDG_CONFIG_HOME/claude.
  // cc-mirror and the desktop app are always scanned; messages count once across roots.
  for (const dir of await childDirectories(known.ccMirror))
    claudeRoots.push({ path: join(dir, "config/projects"), kind: "claude-code", optional: true });
  for (const base of known.desktop)
    for (const path of await desktopRoots(base, local))
      claudeRoots.push({ path, kind: "claude-desktop", optional: true });
  const codexRoots = [];
  for (const dir of known.codexHomes) {
    codexRoots.push({ path: join(dir, "sessions"), kind: "codex", explicit: known.codexExplicit });
    codexRoots.push({ path: join(dir, "archived_sessions"), kind: "codex", optional: true });
  }
  // Extra folders the member accepted (discovery, --review): counted when present.
  for (const extra of extraRoots) {
    if (extra.provider === "claude")
      for (const sub of ["projects", "transcripts"])
        claudeRoots.push({ path: join(extra.path, sub), kind: "claude-other", optional: true });
    else if (extra.provider === "codex")
      for (const sub of ["sessions", "archived_sessions"])
        codexRoots.push({ path: join(extra.path, sub), kind: "codex-other", optional: true });
  }
  if (known.invalid) {
    note("connector", "invalid_root");
  } else {
    await Promise.all([scanRoots(claudeRoots, "claude"), scanRoots(codexRoots, "codex")]);
  }
  const buckets = new Map();
  function aggregate(provider, value, requests = 1) {
    const key = [value.day, provider, value.model].join(":");
    const old = buckets.get(key) ?? {
      day: value.day,
      provider,
      model: value.model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
      total: 0,
      requests: 0,
    };
    const next = { ...old };
    for (const field of [...COUNTERS, "total"]) next[field] = sum([old[field], value[field]]);
    next.requests = sum([old.requests, requests]);
    buckets.set(key, next);
    // Local coverage only: never part of the upload.
    const kind = value.kind ?? provider,
      month = value.day.slice(0, 7);
    local.months[kind] ??= {};
    local.months[kind][month] = (local.months[kind][month] ?? 0) + value.total;
    local.fileMonths[kind] ??= {};
    (local.fileMonths[kind][month] ??= new Set()).add(value.file);
    local.totals[provider] += value.total;
  }
  for (const [key, value] of claude) {
    if (!invalidClaude.has(key)) {
      try {
        aggregate("claude", value);
      } catch {
        note("claude", "unsafe_total");
      }
    }
  }
  // Codex responses with a record count once each, under the model of their turn.
  for (const value of responses.values()) {
    if (value.model === null) {
      note("codex", "missing_context");
      continue;
    }
    try {
      aggregate("codex", value);
    } catch {
      note("codex", "unsafe_total");
    }
  }
  // Files, or the part of a file, with no records (Codex logs from before September
  // 2026): each file on its own, one increment per distinct snapshot: the snapshot's
  // own last_token_usage, or the rise in its cumulative counter when that is missing.
  // A snapshot copied verbatim into another file (replayed parent history) counts once.
  const increments = new Map(),
    conflicts = new Set();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: 0 };
  for (const values of codexFiles) {
    const ordered = values.sort((a, b) => a.time - b.time || a.total - b.total);
    let prev = zero,
      needsBaseline = false;
    for (let at = 0; at < ordered.length; ) {
      const group = [];
      const time = ordered[at].time;
      while (at < ordered.length && ordered[at].time === time) group.push(ordered[at++]);
      if (
        new Set(group.filter((v) => v.model !== null).map((v) => v.model)).size > 1 ||
        group.some((v, i) => i > 0 && ["input", "output"].some((k) => v[k] < group[i - 1][k]))
      ) {
        note("codex", "ambiguous_snapshot");
        needsBaseline = true;
        continue;
      }
      if (group.some((v) => v.model === null)) {
        // Unknown-model usage is only a baseline, never attributed to the next model.
        prev = group.at(-1);
        needsBaseline = false;
        continue;
      }
      for (const v of group) {
        if (needsBaseline) {
          prev = v;
          needsBaseline = false;
          continue;
        }
        if (v.input === prev.input && v.output === prev.output) {
          prev = v;
          continue;
        }
        const dropped = ["input", "output"].some((k) => v[k] < prev[k]);
        let delta;
        if (v.last) delta = { ...v.last };
        else if (dropped && v.compacted) delta = { ...v };
        else if (dropped) {
          // An unmarked reset: keep measured history on either side, never guess its increment.
          note("codex", "ambiguous_snapshot");
          prev = v;
          continue;
        } else {
          delta = {};
          for (const k of [...COUNTERS, "total"]) delta[k] = v[k] - prev[k];
        }
        if (
          delta.cacheRead < 0 ||
          delta.cacheCreation < 0 ||
          delta.cacheRead + delta.cacheCreation > delta.input ||
          delta.reasoning < 0 ||
          delta.reasoning > delta.output
        ) {
          note("codex", "breakdown_corrected");
          delta.cacheRead = 0;
          delta.cacheCreation = 0;
          delta.reasoning = 0;
        }
        const increment = { day: v.day, model: v.model, kind: v.kind, file: v.file };
        for (const k of [...COUNTERS, "total"]) increment[k] = delta[k];
        const key = [v.time, ...COUNTERS.map((k) => v[k])].join(":");
        const old = increments.get(key);
        if (!old || increment.total < old.total) increments.set(key, increment);
        if (old && old.model !== increment.model) conflicts.add(key);
        prev = v;
      }
    }
  }
  for (const [key, increment] of increments) {
    if (conflicts.has(key)) {
      note("codex", "ambiguous_snapshot");
      continue;
    }
    try {
      aggregate("codex", increment);
    } catch {
      note("codex", "unsafe_total");
    }
  }
  // Deleted-history backfill, per machine and UTC day. Claude: per model, the larger of
  // the transcripts and the daily summary, never their sum. Codex: a day with any log
  // usage keeps the logs alone; the thread list fills only days with none. A failure
  // here never lowers a log count.
  if (!known.invalid) {
    const code = (name) => (local.backfill.codes[name] = (local.backfill.codes[name] ?? 0) + 1);
    const logged = (provider) => new Set([...buckets.values()].filter((x) => x.provider === provider).map((x) => x.day));
    // The upload validator needs total = input + output (+ cache for Claude) and
    // total <= requests x 20M. A summary has one total per model, so the count rides
    // in `input` (the other splits zero) with the fewest requests the bound accepts.
    const fill = (provider, day, model, tokens, kind, file) =>
      aggregate(
        provider,
        { day, model, kind, file, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0, total: tokens },
        Math.max(1, Math.ceil(tokens / ROW_BOUND)),
      );
    try {
      const days = logged("claude"),
        seen = new Set(),
        filled = new Set(),
        found = new Map();
      // Every Claude config folder the scan reads: the parent of each projects folder.
      const dirs = new Map();
      for (const root of claudeRoots)
        if (basename(root.path) === "projects" && !dirs.has(dirname(root.path))) dirs.set(dirname(root.path), root.kind);
      for (const [dir, kind] of dirs) {
        // A missing summary is worth a local code only where transcripts exist to be partial.
        const summary = await readClaudeSummary(dir, code, { seen, missing: kind !== "claude-desktop" && days.size > 0 }).catch(() => (code("summary_unreadable"), null));
        if (!summary) continue;
        const file = fileCount++;
        // Every config folder's summary, per day and model, summed like the transcripts.
        for (const [day, models] of summary)
          for (const [model, tokens] of models) {
            const key = [day, "claude", model].join(":");
            const old = found.get(key) ?? { day, model, tokens: 0, files: [] };
            const total = old.tokens + tokens;
            if (!Number.isSafeInteger(total)) {
              code("summary_bad_count");
              continue;
            }
            found.set(key, { day, model, tokens: total, files: [...old.files, file] });
          }
      }
      // Per day and model, the larger of transcripts and summary, never their sum: both
      // count input + output + cache reads + cache writes, so a day whose transcripts were
      // partly deleted is raised to the summary's count, and one whose transcripts are
      // larger keeps them. The transcript row stays; only the shortfall is added.
      const used = new Set();
      for (const [key, { day, model, tokens, files }] of found) {
        const counted = buckets.get(key)?.total ?? 0;
        if (tokens <= counted) continue;
        try {
          fill("claude", day, model, tokens - counted, "claude-summary", files[0]);
          for (const file of files) used.add(file);
          filled.add(day);
        } catch {
          code("summary_bad_count");
        }
      }
      if (used.size) local.files["claude-summary"] = (local.files["claude-summary"] ?? 0) + used.size;
      local.backfill.claude = filled.size;
    } catch {
      code("summary_unreadable");
    }
    try {
      const days = logged("codex"),
        seen = new Set(),
        filled = new Set();
      const homes = [...new Set(codexRoots.filter((x) => basename(x.path) === "sessions").map((x) => dirname(x.path)))];
      for (const dir of homes) {
        const threads = await readCodexThreads(dir, code, { seen }).catch(() => (code("threads_unreadable"), null));
        if (!threads) continue;
        const file = fileCount++;
        let used = false;
        for (const thread of threads) {
          // A thread whose rollout is still here was counted from that rollout.
          if (days.has(thread.day) || rollouts.has(basename(thread.rollout))) continue;
          if (await lstat(thread.rollout).then(() => true, (e) => e.code !== "ENOENT")) continue;
          try {
            fill("codex", thread.day, thread.model, thread.tokens, "codex-summary", file);
            used = true;
            filled.add(thread.day);
          } catch {
            code("threads_bad_count");
          }
        }
        if (used) local.files["codex-summary"] = (local.files["codex-summary"] ?? 0) + 1;
      }
      local.backfill.codex = filled.size;
    } catch {
      code("threads_unreadable");
    }
  }
  const usage = [...buckets.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  const days = usage.map((x) => x.day).sort();
  if (!usage.length) note("connector", "no_usable_usage");
  const data = {
    schemaVersion: 1,
    connectorVersion: "0.2.9",
    status: !usage.length ? "error" : incomplete ? "partial" : "ok",
    coverage: { from: days[0] ?? null, to: days.at(-1) ?? null },
    usage,
    diagnostics: [...diagnostics]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => {
        const [provider, code] = key.split(":");
        return { provider, code, count };
      }),
  };
  return { data, local };
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.some((x) => !["--json", "--dry-run", "--help", "--review"].includes(x)) ||
    new Set(argv).size !== argv.length ||
    ((argv.includes("--help") || argv.includes("--review")) && argv.length !== 1)
  ) {
    console.error("Token Club: invalid arguments. Use --help.");
    return 1;
  }
  if (argv.includes("--help")) {
    console.log(
      "Token Club local aggregate export\nUsage: node connect.mjs [--json] [--dry-run] | --review\nReads local Claude Code and Codex histories. No upload or browser opening.\nConfigure roots with CLAUDE_CONFIG_DIR and CODEX_HOME. For automatic sync, use the install command on the Token Club page.\n--review (in the installed Token Club folder) lists history folders found on this machine and asks whether to count them.",
    );
    return 0;
  }
  if (argv.includes("--review")) {
    // Answers live beside the installed sync.mjs, written by its owner-only save helper.
    let sync;
    try {
      sync = await import(new URL("./sync.mjs", import.meta.url).href);
    } catch {
      console.error("Token Club: run --review from the Token Club folder after installing.");
      return 1;
    }
    try {
      await sync.main(["--review"]);
      return 0;
    } catch (error) {
      console.error("Token Club: " + sync.explain(error));
      return 1;
    }
  }
  const { data, local } = await scan();
  if (argv.includes("--json")) console.log(JSON.stringify(data, null, 2));
  else {
    const totals = { claude: 0, codex: 0 };
    for (const row of data.usage) totals[row.provider] += row.total;
    const n = (value) => value.toLocaleString("en-AU");
    console.log(
      `Local history: ${n(totals.claude + totals.codex)} tokens.\nClaude ${n(totals.claude)} | Codex ${n(totals.codex)} | ${data.status}\nhttps://thehourglass.ai/billion-token-club`,
    );
    console.log(formatLocal(local));
    const tip = await historyTip();
    if (tip) console.log(tip);
  }
  if (data.status !== "ok")
    console.error(
      "Token Club: " +
        (data.status === "partial"
          ? "partial coverage; inspect diagnostic codes before using totals."
          : "no usable usage; inspect diagnostic codes and configured roots."),
    );
  return data.status === "ok" ? 0 : data.status === "partial" ? 2 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Token Club: scan failed. No log content is included in this error.");
      process.exitCode = 1;
    });
}
