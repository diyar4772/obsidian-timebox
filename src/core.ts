// Timebox — pure logic.
//
// This file does NOT depend on Obsidian (never import "obsidian" here), so it
// can be unit-tested in Node. Block parsing/serialization, time formatting and
// the pomodoro phase calculation live here. UI code lives in src/main.ts and src/ui/.

export const BLOCK_LANG = "timebox";

export type SessionMode = "simple" | "pomodoro";

export interface Session {
  topic: string;
  start: Date;
  end: Date | null;
  mode: SessionMode;
  /** Unrecognized lines (e.g. "note: p. 42"), in order. Never deleted. */
  extra: string[];
}

export interface PomodoroConfig {
  /** Durations in minutes. */
  work: number;
  short: number;
  long: number;
  /** A long break replaces the short break after every `longEvery`-th focus period. */
  longEvery: number;
}

export type PhaseKind = "work" | "short" | "long";

export interface Phase {
  kind: PhaseKind;
  /** Global phase index since the session started (0-based). Used to detect phase changes. */
  index: number;
  /** Number of the current focus period, or of the one that just ended during a break (1-based). */
  pomodoro: number;
  /** Number of fully completed focus periods. */
  completedWork: number;
  /** Time spent in the current phase (ms). */
  elapsedInPhase: number;
  /** Total length of the current phase (ms). */
  phaseLength: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

// ───────────────────────── formatting ─────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-09-28 18:29:05": the canonical format stored in blocks, also the key used to find a block. */
export function formatStamp(d: Date): string {
  return (
    `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** "18:29" */
export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Live timer: "42:13", or "1:05:09" past one hour. Negative values become 00:00. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Finished session duration: "1h 18m", "42m", "2h", "< 1m". Rounds down to whole minutes. */
export function formatDuration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / MINUTE);
  if (mins < 1) return "< 1m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Calendar-day difference (b - a). Used for the "(+1)" suffix on finished sessions. */
export function dayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  // A day can be 23/25 hours around DST changes; rounding absorbs that.
  return Math.round((db - da) / DAY);
}

// ───────────────────────── time parsing ─────────────────────────

const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function makeDate(y: number, mo: number, d: number, h: number, mi: number, s: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(2000, 0, 1, h, mi, s);
  date.setFullYear(y, mo - 1, d); // new Date(y, …) would map years 0–99 to 1900–1999
  // Reject overflowing dates such as 31.02
  if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** Whether the value is a bare time of day (no date). */
export function isTimeOnly(raw: string): boolean {
  return RE_TIME.test(raw.trim());
}

/**
 * Accepted formats:
 *   "2026-09-28 18:29" / "2026-09-28 18:29:05"   (a T separator works too)
 *   "28.09.2026 18:29" / "28.09.2026 18:29:05"
 *   "18:29" / "18:29:05"   → the day is taken from `dayOf` (today if omitted)
 * Returns null if the value can't be read.
 */
export function parseStamp(raw: string, dayOf?: Date): Date | null {
  const s = raw.trim();
  let m = s.match(RE_ISO);
  if (m) return makeDate(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  m = s.match(RE_DOTTED);
  if (m) return makeDate(+m[3], +m[2], +m[1], +m[4], +m[5], m[6] ? +m[6] : 0);
  m = s.match(RE_TIME);
  if (m) {
    const base = dayOf ?? new Date();
    return makeDate(base.getFullYear(), base.getMonth() + 1, base.getDate(), +m[1], +m[2], m[3] ? +m[3] : 0);
  }
  return null;
}

// ───────────────────────── block parsing ─────────────────────────

type Field = "topic" | "start" | "end" | "mode" | "duration";

const FIELDS: readonly Field[] = ["topic", "start", "end", "mode", "duration"];

/** If the line starts with a known key (case-insensitive), returns the field and its value. */
function fieldOf(line: string): { field: Field; value: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim().toLowerCase() as Field;
  if (!FIELDS.includes(key)) return null;
  return { field: key, value: line.slice(idx + 1).trim() };
}

function parseMode(value: string): SessionMode {
  return /^pomo/i.test(value.trim()) ? "pomodoro" : "simple";
}

export type ParseResult = { ok: true; session: Session } | { ok: false; error: string };

const FORMAT_HINT = "Expected YYYY-MM-DD HH:mm, DD.MM.YYYY HH:mm or HH:mm.";

/**
 * Parses the contents of a `timebox` block.
 * @param dayOf Day to use when the start is a bare time (the note's creation date).
 */
export function parseBlock(source: string, dayOf?: Date): ParseResult {
  let topic = "";
  let startRaw: string | null = null;
  let endRaw: string | null = null;
  let mode: SessionMode = "simple";
  const extra: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const f = fieldOf(line);
    if (!f) {
      if (line.trim() !== "") extra.push(line);
      continue;
    }
    switch (f.field) {
      case "topic":
        topic = f.value;
        break;
      case "start":
        startRaw = f.value;
        break;
      case "end":
        endRaw = f.value;
        break;
      case "mode":
        mode = parseMode(f.value);
        break;
      case "duration":
        break; // ignored: always recomputed from the end time
    }
  }

  if (startRaw === null || startRaw === "") {
    return { ok: false, error: "Missing “start:” line. Example: start: 2026-09-28 18:29" };
  }
  const start = parseStamp(startRaw, dayOf);
  if (!start) return { ok: false, error: `Can't read the start time “${startRaw}”. ${FORMAT_HINT}` };

  let end: Date | null = null;
  if (endRaw !== null && endRaw !== "") {
    end = parseStamp(endRaw, start);
    if (!end) return { ok: false, error: `Can't read the end time “${endRaw}”. ${FORMAT_HINT}` };
    if (end < start) {
      // A bare time earlier than the start means midnight was crossed: move it to the next day.
      // Re-read the time on the next calendar day (adding 24 h would be off by an hour on DST nights).
      if (isTimeOnly(endRaw)) {
        const nextDay = new Date(start.getTime());
        nextDay.setDate(nextDay.getDate() + 1);
        end = parseStamp(endRaw, nextDay);
      }
      if (!end || end < start) return { ok: false, error: "The end time can't be before the start time." };
    }
  }

  return { ok: true, session: { topic, start, end, mode, extra } };
}

// ───────────────────────── block writing ─────────────────────────

/** Canonical lines of a session (field → line). Absent fields are omitted. */
function canonicalLines(s: Session): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {
    topic: `topic: ${s.topic}`,
    start: `start: ${formatStamp(s.start)}`,
  };
  if (s.mode === "pomodoro") out.mode = "mode: pomodoro";
  if (s.end) {
    out.end = `end: ${formatStamp(s.end)}`;
    out.duration = `duration: ${formatDuration(s.end.getTime() - s.start.getTime())}`;
  }
  return out;
}

const FIELD_ORDER: Field[] = ["topic", "start", "mode", "end", "duration"];

/** Builds new block contents (without fences). An empty topic produces no "topic:" line. */
export function serializeBlock(s: Session): string {
  const c = canonicalLines(s);
  const lines = FIELD_ORDER.filter((f) => f !== "topic" || s.topic !== "")
    .map((f) => c[f])
    .filter((l): l is string => l !== undefined);
  return [...lines, ...s.extra].join("\n");
}

/** Builds a complete block including fences. */
export function buildBlock(s: Session): string {
  return "```" + BLOCK_LANG + "\n" + serializeBlock(s) + "\n```";
}

/**
 * Rewrites an existing block body with new session data.
 * - Unrecognized lines and blank lines stay where they are.
 * - Known lines are replaced with their canonical form (duplicates collapse to one).
 * - Missing fields are inserted after the last field that precedes them in canonical order.
 * - `duration` is always written directly below `end`.
 */
export function rewriteBody(bodyLines: string[], s: Session): string[] {
  const canon = canonicalLines(s);
  const out: { line: string; field?: Field }[] = [];
  const emitted = new Set<Field>();

  for (const line of bodyLines) {
    const f = fieldOf(line);
    if (!f) {
      out.push({ line });
      continue;
    }
    if (f.field === "duration" || emitted.has(f.field)) continue;
    const c = canon[f.field];
    if (c === undefined) continue; // e.g. a stale "mode:" line on a simple session
    out.push({ line: c, field: f.field });
    emitted.add(f.field);
  }

  const order = (f: Field) => FIELD_ORDER.indexOf(f);
  for (const f of FIELD_ORDER) {
    const c = canon[f];
    if (c === undefined || emitted.has(f)) continue;
    if (f === "topic" && s.topic === "") continue;
    // insert after the last field that comes before this one in canonical order
    let at = -1;
    for (let i = 0; i < out.length; i++) {
      const g = out[i].field;
      if (g !== undefined && order(g) < order(f)) at = i + 1;
    }
    if (at < 0) {
      // nothing precedes it: put it before the first known line (or at the very top)
      const first = out.findIndex((o) => o.field !== undefined);
      at = first < 0 ? 0 : first;
    }
    out.splice(at, 0, { line: c, field: f });
    emitted.add(f);
  }

  // keep duration directly below end
  const durIdx = out.findIndex((o) => o.field === "duration");
  const endIdx = out.findIndex((o) => o.field === "end");
  if (durIdx >= 0 && endIdx >= 0 && durIdx !== endIdx + 1) {
    const [dur] = out.splice(durIdx, 1);
    out.splice(out.findIndex((o) => o.field === "end") + 1, 0, dur);
  }
  return out.map((o) => o.line);
}

// ───────────────────────── finding blocks in a file ─────────────────────────

export interface FoundBlock {
  /** Line number of the opening fence (0-based). */
  openLine: number;
  /**
   * First line after the body: the closing fence, or, when the block is closed implicitly
   * because its blockquote or list item ended, the first line outside that container.
   */
  closeLine: number;
  /** Whether the block ends with an explicit closing fence. */
  closed: boolean;
  /** The opening fence's quote/indent prefix (e.g. "> " or "  "). Written in front of new body lines. */
  prefix: string;
  /** Body lines with the container prefix removed. */
  body: string[];
  session: Session;
}

/** Any fenced code block, whatever its language. */
interface Fence {
  openLine: number;
  /** See FoundBlock.closeLine. For an unclosed top-level fence this is the line count. */
  closeLine: number;
  closed: boolean;
  lang: string;
  prefix: string;
  body: string[];
}

// Opening fence: blockquote markers, indentation, 3+ ` or ~, then the info string.
// Each repetition of the quote group must end in ">", so matching stays linear in the
// line length (a form like `[ \t]*(?:>[ \t]?)*[ \t]*` backtracks quadratically on long
// whitespace-only lines and could freeze the editor).
const RE_FENCE_OPEN = /^((?:[ \t]*>)*)([ \t]*)(`{3,}|~{3,})(.*)$/;
const RE_QUOTE_MARKER = /^[ \t]*>/;
const RE_LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;
/** How far up to look for the list item that owns an indented fence. */
const LIST_LOOKBACK = 200;

/** Splits on LF, remembering which lines ended with CR so mixed line endings survive edits. */
function splitLines(text: string): { lines: string[]; cr: boolean[] } {
  const lines = text.split("\n");
  const cr = lines.map((l) => l.endsWith("\r"));
  return { lines: lines.map((l, i) => (cr[i] ? l.slice(0, -1) : l)), cr };
}

/** Visual width of leading whitespace (a tab counts as 4 columns). */
function indentWidth(ws: string): number {
  let w = 0;
  for (const c of ws) w += c === "\t" ? 4 - (w % 4) : 1;
  return w;
}

/** Removes `depth` blockquote markers. Returns null if the line has fewer markers (the quote ended). */
function stripQuotes(line: string, depth: number): string | null {
  let rest = line;
  for (let k = 0; k < depth; k++) {
    const m = rest.match(RE_QUOTE_MARKER);
    if (!m) return null;
    rest = rest.slice(m[0].length);
  }
  // one optional space after the last marker belongs to the marker
  if (depth > 0 && (rest[0] === " " || rest[0] === "\t")) rest = rest.slice(1);
  return rest;
}

/** Removes up to `cols` columns of leading whitespace. */
function stripIndent(line: string, cols: number): string {
  let w = 0;
  let i = 0;
  while (i < line.length && w < cols && (line[i] === " " || line[i] === "\t")) {
    w += line[i] === "\t" ? 4 - (w % 4) : 1;
    i++;
  }
  return line.slice(i);
}

/**
 * For a fence indented by `indent` columns, finds the content column of the list item it
 * belongs to (looking a limited number of lines up), or -1 if it isn't in a list.
 */
function listContainerColumn(lines: string[], openLine: number, depth: number, indent: number): number {
  for (let k = openLine - 1; k >= 0 && k >= openLine - LIST_LOOKBACK; k--) {
    const inner = stripQuotes(lines[k], depth);
    if (inner === null) return -1;
    if (inner.trim() === "") continue;
    const m = inner.match(RE_LIST_ITEM);
    if (m) {
      const col = indentWidth(m[1]) + m[2].length + Math.max(1, indentWidth(m[3]));
      if (col <= indent && indent - col <= 3) return col;
      continue; // a deeper or shallower sibling item; keep looking for the owner
    }
    const lead = indentWidth(inner.match(/^[ \t]*/)![0]);
    if (lead === 0) return -1; // plain top-level text: not inside a list
  }
  return -1;
}

/**
 * Scans the text for fenced code blocks of every language, following CommonMark:
 * - a closing fence uses the same character, is at least as long as the opening one,
 *   is indented at most 3 columns (relative to its container) and has nothing after it;
 * - a fence inside a blockquote ends when the blockquote ends (a line without enough ">");
 * - a fence inside a list item ends when a non-blank line is indented less than the item's content;
 * - a line indented 4+ columns outside a list is an indented code block, not a fence;
 * - an unclosed top-level fence runs to the end of the document.
 */
function scanFences(lines: string[]): Fence[] {
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RE_FENCE_OPEN);
    if (!m) continue;
    const [, quote, ws, fence, info] = m;
    const ch = fence[0];
    // CommonMark: a backtick fence's info string can't contain backticks (that's inline code).
    if (ch === "`" && info.includes("`")) continue;

    const depth = (quote.match(/>/g) ?? []).length;
    // indentation after the quote marker's optional space
    const afterQuote = depth > 0 && (ws[0] === " " || ws[0] === "\t") ? ws.slice(1) : ws;
    const indent = indentWidth(afterQuote);
    let container = 0;
    if (indent > 0) {
      container = listContainerColumn(lines, i, depth, indent);
      if (container < 0) {
        if (indent >= 4) continue; // indented code block, not a fence
        container = 0;
      }
    }

    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const inner = stripQuotes(lines[j], depth);
      if (inner === null) break; // the blockquote ended
      if (container > 0 && inner.trim() !== "" && indentWidth(inner.match(/^[ \t]*/)![0]) < container) break; // the list item ended
      const rel = stripIndent(inner, container);
      const lead = indentWidth(rel.match(/^[ \t]*/)![0]);
      const t = rel.trim();
      if (lead <= 3 && t.length >= fence.length && t === ch.repeat(t.length)) {
        closed = true;
        break;
      }
      body.push(stripIndent(inner, indent));
    }

    const lang = info.trim().split(/\s+/)[0].toLowerCase();
    out.push({ openLine: i, closeLine: j, closed, lang, prefix: quote + ws, body });
    if (!closed && depth === 0 && container === 0) break; // runs to the end of the document
    i = closed ? j : j - 1;
  }
  return out;
}

/**
 * Finds every valid `timebox` block in the text.
 * Code blocks in other languages are skipped as well, so an example `timebox`
 * block inside a ```markdown block is not mistaken for a real one.
 * An unclosed top-level block is ignored; a block closed implicitly by the end of its
 * blockquote or list item counts, and only its own lines belong to it.
 */
export function findBlocks(text: string, dayOf?: Date): FoundBlock[] {
  const { lines } = splitLines(text);
  const out: FoundBlock[] = [];
  for (const f of scanFences(lines)) {
    if (f.lang !== BLOCK_LANG) continue;
    if (!f.closed && f.closeLine >= lines.length) continue; // never closed before the end of the note
    const parsed = parseBlock(f.body.join("\n"), dayOf);
    if (parsed.ok) {
      out.push({ openLine: f.openLine, closeLine: f.closeLine, closed: f.closed, prefix: f.prefix, body: f.body, session: parsed.session });
    }
  }
  return out;
}

/**
 * Finds the block whose start time matches. If several match (e.g. a copied block),
 * a running one is preferred over a finished one.
 */
export function findBlockByStart(text: string, start: Date, dayOf?: Date): FoundBlock | null {
  const key = formatStamp(start);
  const matches = findBlocks(text, dayOf).filter((b) => formatStamp(b.session.start) === key);
  return matches.find((b) => !b.session.end) ?? matches[0] ?? null;
}

export interface BlockEdit {
  /** First body line to replace (the line after the opening fence). */
  fromLine: number;
  /** End of the replaced range (exclusive): the closing fence, or the first line after the body. */
  toLine: number;
  /** New body lines (prefix included). */
  lines: string[];
  /** True when nothing needs to change (e.g. the session was already finished). */
  unchanged?: boolean;
}

function editFor(b: FoundBlock, next: Session): BlockEdit {
  const lines = rewriteBody(b.body, next).map((l) => (l === "" ? b.prefix.trimEnd() : b.prefix + l));
  return { fromLine: b.openLine + 1, toLine: b.closeLine, lines };
}

/**
 * Computes the edit that rewrites the block starting at `start` using `update`.
 * Both the editor path (replaceRange) and the file path (vault.process) use it.
 * Returns null if the block isn't found.
 */
export function planReplace(
  text: string,
  start: Date,
  update: (current: Session) => Session,
  dayOf?: Date
): BlockEdit | null {
  const b = findBlockByStart(text, start, dayOf);
  return b ? editFor(b, update(b.session)) : null;
}

/**
 * The edit that finishes the session at `end`. If the matching block already has an end
 * (for example the user typed one by hand), it is left alone and the edit is marked unchanged.
 */
export function planFinish(text: string, start: Date, end: Date, dayOf?: Date): BlockEdit | null {
  const b = findBlockByStart(text, start, dayOf);
  if (!b) return null;
  if (b.session.end) return { fromLine: b.openLine + 1, toLine: b.closeLine, lines: [], unchanged: true };
  return editFor(b, { ...b.session, end });
}

/** Applies an edit to the text. Each untouched line keeps its own line ending (LF or CRLF). */
export function applyEdit(text: string, edit: BlockEdit): string {
  if (edit.unchanged) return text;
  const { lines, cr } = splitLines(text);
  const useCr = cr[edit.fromLine - 1] ?? false; // new lines follow the opening fence's ending
  lines.splice(edit.fromLine, edit.toLine - edit.fromLine, ...edit.lines);
  cr.splice(edit.fromLine, edit.toLine - edit.fromLine, ...edit.lines.map(() => useCr));
  return lines.map((l, i) => (cr[i] ? l + "\r" : l)).join("\n");
}

// ───────────────────────── inserting a new block ─────────────────────────

export interface InsertPlan {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  text: string;
  /** Where the cursor goes afterwards: an empty line below the block. */
  cursor: { line: number; ch: number };
  /** Line of the inserted opening fence. */
  openLine: number;
}

const RE_QUOTE_PREFIX = /^(?:[ \t]*>)+[ \t]?/;

/**
 * Plans inserting `block` at the cursor line (pure; the caller applies it with one replaceRange):
 * - an empty line is replaced, otherwise the block goes on the line below;
 * - inside a blockquote/callout, the block gets the same ">" prefix so it stays inside;
 * - inside another code block, the block goes below that code block instead of into it;
 * - an empty line is kept (or added) below the block for the cursor.
 */
export function planInsert(text: string, cursorLine: number, block: string): InsertPlan {
  const { lines } = splitLines(text);
  let anchor = Math.min(Math.max(0, cursorLine), lines.length - 1);
  let inFence = false;
  let quoteSource = lines[anchor];

  for (const f of scanFences(lines)) {
    const last = f.closed ? f.closeLine : f.closeLine - 1;
    if (anchor < f.openLine || anchor > last) continue;
    inFence = true;
    quoteSource = lines[f.openLine];
    if (f.closed || f.closeLine < lines.length) {
      anchor = last; // below the code block
    } else {
      // an unclosed code block runs to the end: put the block above it
      const prefix = (quoteSource.match(RE_QUOTE_PREFIX) ?? [""])[0];
      const body = block.split("\n").map((l) => prefix + l);
      const insert = body.join("\n") + "\n" + prefix.trimEnd() + "\n";
      return {
        from: { line: f.openLine, ch: 0 },
        to: { line: f.openLine, ch: 0 },
        text: insert,
        cursor: { line: f.openLine + body.length, ch: prefix.trimEnd().length },
        openLine: f.openLine,
      };
    }
    break;
  }

  const prefix = (quoteSource.match(RE_QUOTE_PREFIX) ?? [""])[0];
  const blockLines = block.split("\n").map((l) => prefix + l);
  const current = lines[anchor];
  const isEmpty = !inFence && current.slice((current.match(RE_QUOTE_PREFIX) ?? [""])[0].length).trim() === "";

  const next = lines[anchor + 1];
  const trailingLine = prefix.trimEnd() === "" ? "" : prefix;
  const nextIsFree =
    next !== undefined && (prefix === "" ? next.trim() === "" : next.trimEnd() === prefix.trimEnd());
  const trailing = nextIsFree ? "" : "\n" + trailingLine;

  const openLine = isEmpty ? anchor : anchor + 1;
  const closeLine = openLine + blockLines.length - 1;
  const cursorCh = nextIsFree ? next.length : trailingLine.length;
  return isEmpty
    ? {
        from: { line: anchor, ch: 0 },
        to: { line: anchor, ch: current.length },
        text: blockLines.join("\n") + trailing,
        cursor: { line: closeLine + 1, ch: cursorCh },
        openLine,
      }
    : {
        from: { line: anchor, ch: current.length },
        to: { line: anchor, ch: current.length },
        text: "\n" + blockLines.join("\n") + trailing,
        cursor: { line: closeLine + 1, ch: cursorCh },
        openLine,
      };
}

/**
 * Rewrites the block whose start time matches with the `next` session.
 * Everything outside the block (other code blocks included) is left untouched,
 * and unrecognized lines inside the block stay in place. Returns null if not found.
 */
export function replaceBlock(text: string, start: Date, next: Session, dayOf?: Date): string | null {
  const edit = planReplace(text, start, () => next, dayOf);
  return edit ? applyEdit(text, edit) : null;
}

// ───────────────────────── pomodoro ─────────────────────────

function positive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Returns the pomodoro phase `elapsedMs` after the session started.
 *
 * Stateless: no counter is stored, only the elapsed time is used, so the
 * result stays correct across Obsidian restarts and devices.
 *
 * Cycle: focus, short break, focus, short break, …; after every `longEvery`-th
 * focus period a long break replaces the short one. Computed in constant time
 * by dividing by the cycle length instead of stepping through phases.
 */
export function pomodoroPhase(elapsedMs: number, cfg: PomodoroConfig): Phase {
  const W = positive(cfg.work, 25) * MINUTE;
  const S = positive(cfg.short, 5) * MINUTE;
  const L = positive(cfg.long, 15) * MINUTE;
  const n = Math.max(1, Math.floor(positive(cfg.longEvery, 4)));

  const pair = W + S; // focus + short break
  const cycleLen = n * W + (n - 1) * S + L; // n focus periods, n-1 short breaks, 1 long break

  const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const k = Math.floor(t / cycleLen); // completed full cycles
  const r = t - k * cycleLen; // position within the current cycle
  const j = Math.min(Math.floor(r / pair), n - 1); // focus slot within the cycle (0..n-1)
  const r2 = r - j * pair; // time since that slot started
  const doneBefore = k * n + j; // focus periods completed before this slot
  const baseIndex = k * 2 * n + 2 * j;

  if (r2 < W) {
    return {
      kind: "work",
      index: baseIndex,
      pomodoro: doneBefore + 1,
      completedWork: doneBefore,
      elapsedInPhase: r2,
      phaseLength: W,
    };
  }
  const isLong = j === n - 1;
  return {
    kind: isLong ? "long" : "short",
    index: baseIndex + 1,
    pomodoro: doneBefore + 1,
    completedWork: doneBefore + 1,
    elapsedInPhase: r2 - W,
    phaseLength: isLong ? L : S,
  };
}

/** Number of fully completed focus periods in a finished pomodoro session. */
export function completedPomodoros(durationMs: number, cfg: PomodoroConfig): number {
  return pomodoroPhase(durationMs, cfg).completedWork;
}

export const PHASE_LABEL: Record<PhaseKind, string> = {
  work: "Focus",
  short: "Short break",
  long: "Long break",
};

export const PHASE_EMOJI: Record<PhaseKind, string> = {
  work: "🍅",
  short: "☕",
  long: "☕",
};
