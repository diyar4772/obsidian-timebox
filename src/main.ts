import { Editor, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import {
  BLOCK_LANG,
  BlockEdit,
  PHASE_EMOJI,
  PHASE_LABEL,
  ParseResult,
  Session,
  SessionMode,
  addBreak,
  applyEdit,
  applyInsert,
  buildBlock,
  findBlockByStart,
  findBlocks,
  formatDuration,
  formatStamp,
  formatTimer,
  isUnclosedAtEnd,
  openPause,
  parseBlock,
  parseStamp,
  pauseAt,
  pausedMs,
  planChange,
  planFinish,
  planInsert,
  pomodoroPhase,
  resumeAt,
} from "./core";
import { TimeboxSettingTab, TimeboxSettings, pomodoroConfig, sanitizeSettings } from "./settings";
import { Alerts } from "./ui/alerts";
import { AwayModal, BreakModal, FinishAtModal, SessionSuggestModal } from "./ui/modals";
import { SessionBar } from "./ui/session-bar";
import { TopicModal } from "./ui/topic-modal";

/** An active session record stored in data.json. */
export interface ActiveEntry {
  /** Vault path of the note that contains the session. */
  path: string;
  /** formatStamp(start). The key used to find the block in the file. */
  start: string;
  topic: string;
  mode: SessionMode;
  /** Total length of the finished breaks (ms). Missing in entries written by 1.0.x. */
  pausedMs?: number;
  /** formatStamp of the moment the session was paused, or null while it runs. */
  pausedAt?: string | null;
}

/** Enough information to find a session in a file. */
export type SessionRef = Pick<ActiveEntry, "path" | "start">;

interface PluginData {
  settings: TimeboxSettings;
  active: ActiveEntry[];
}

const TICK_MS = 1000;
const PRUNE_MS = 30_000;

/** Device-local storage key for the last moment this device saw a session running. */
const SEEN_KEY = "timebox-last-seen";

const keyOf = (r: SessionRef) => `${r.path}\u0000${r.start}`;

/** The current second, without milliseconds (times are written with second precision). */
function nowSecond(): Date {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

/** Time worked in an active session up to `now` (ms): elapsed minus breaks, frozen while paused. */
export function entryWorked(a: ActiveEntry, now: number): number {
  const start = parseStamp(a.start);
  if (!start) return 0;
  const until = (a.pausedAt ? parseStamp(a.pausedAt)?.getTime() : undefined) ?? now;
  return Math.max(0, until - start.getTime() - (a.pausedMs ?? 0));
}

export default class TimeboxPlugin extends Plugin {
  settings!: TimeboxSettings;
  /** Active sessions in the order they were started (last = newest). */
  active: ActiveEntry[] = [];

  private statusEl: HTMLElement | null = null;
  /** Last seen pomodoro phase index per session, to detect phase changes. Not persisted. */
  private lastPhase = new Map<string, number>();
  /** How many long-session reminders each session has had. Not persisted. */
  private lastRemind = new Map<string, number>();
  private alerts = new Alerts();
  /** Time of the previous tick; a large jump means the computer slept. */
  private lastTick = Date.now();
  private awayOpen = false;

  async onload(): Promise<void> {
    await this.loadState();

    this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => {
      const dayOf = this.fileDay(ctx.sourcePath);
      let result: ParseResult = parseBlock(source, dayOf);
      // A fence that is never closed runs to the end of the note: it renders, but can't be finished.
      const info = typeof ctx.getSectionInfo === "function" ? ctx.getSectionInfo(el) : null;
      if (result.ok && info && isUnclosedAtEnd(info.text, info.lineStart, info.lineEnd, source, dayOf)) {
        result = { ok: false, error: "This block has no closing fence. Add a line with ``` below it." };
      }
      // Blocks from non-markdown sources (e.g. Canvas cards) can't be located in a file; don't track them.
      if (result.ok && !result.session.end && ctx.sourcePath.endsWith(".md")) {
        this.observeActive(ctx.sourcePath, result.session);
      }
      ctx.addChild(new SessionBar(el, this, result, ctx.sourcePath));
    });

    this.addCommand({
      id: "start-session",
      name: "Start session",
      editorCallback: (editor, ctx) => this.startFromEditor(editor, ctx, this.settings.defaultMode),
    });
    this.addCommand({
      id: "start-pomodoro-session",
      name: "Start pomodoro session",
      editorCallback: (editor, ctx) => this.startFromEditor(editor, ctx, "pomodoro"),
    });
    this.addCommand({
      id: "start-simple-session",
      name: "Start simple session (no pomodoro)",
      editorCallback: (editor, ctx) => this.startFromEditor(editor, ctx, "simple"),
    });
    this.addCommand({
      id: "finish-active-session",
      name: "Finish active session",
      checkCallback: (checking) => {
        const target = this.preferredActive();
        if (!target) return false;
        if (!checking) void this.stopSession(target);
        return true;
      },
    });

    this.addCommand({
      id: "pause-resume-active-session",
      name: "Pause or resume active session",
      checkCallback: (checking) => {
        const target = this.preferredActive();
        if (!target) return false;
        if (!checking) void (target.pausedAt ? this.resumeSession(target) : this.pauseSession(target));
        return true;
      },
    });
    this.addCommand({
      id: "choose-session-to-finish",
      name: "Choose a session to finish",
      checkCallback: (checking) => {
        if (this.active.length === 0) return false;
        if (!checking) this.chooseSession("Finish which session?", (a) => void this.stopSession(a));
        return true;
      },
    });
    this.addCommand({
      id: "finish-active-session-earlier",
      name: "Finish active session at an earlier time",
      checkCallback: (checking) => {
        const target = this.preferredActive();
        if (!target) return false;
        if (!checking) void this.promptFinishAt(target);
        return true;
      },
    });
    this.addCommand({
      id: "add-break-to-active-session",
      name: "Add a break to active session",
      checkCallback: (checking) => {
        const target = this.preferredActive();
        if (!target) return false;
        if (!checking) void this.promptBreak(target);
        return true;
      },
    });

    this.addRibbonIcon("timer", "Start session", () => void this.startFromRibbon());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("timebox-status", "mod-clickable");
    this.registerDomEvent(this.statusEl, "click", (evt) => this.onStatusClick(evt));

    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
    this.registerInterval(window.setInterval(() => void this.pruneActive(), PRUNE_MS));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));

    this.addSettingTab(new TimeboxSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.pruneActive().then(() => this.checkAwayOnStartup()));
    this.tick();
  }

  onunload(): void {
    this.alerts.dispose();
  }

  // ───────────────────────── persistence ─────────────────────────

  private async loadState(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Partial<Record<keyof PluginData, unknown>>;
    this.settings = sanitizeSettings(raw.settings);
    this.active = Array.isArray(raw.active) ? raw.active.filter(isActiveEntry) : [];
  }

  private async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, active: this.active };
    await this.saveData(data);
    this.markSeen();
  }

  /**
   * Remembers, on this device only, that sessions were running just now. On the next start this
   * tells how long Obsidian was closed. localStorage is used so nothing is synced or written to
   * data.json every 30 s. The API exists since Obsidian 1.8.7; older versions skip the feature.
   */
  private markSeen(): void {
    if (this.active.length === 0) return;
    const app = this.app as { saveLocalStorage?: (key: string, value: unknown) => void };
    if (typeof app.saveLocalStorage === "function") app.saveLocalStorage(SEEN_KEY, String(Date.now()));
  }

  private lastSeen(): number | null {
    const app = this.app as { loadLocalStorage?: (key: string) => unknown };
    if (typeof app.loadLocalStorage !== "function") return null;
    const n = Number(app.loadLocalStorage(SEEN_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.tick();
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Day used for bare start times: the note's creation date. */
  private fileDay(path: string): Date | undefined {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? new Date(f.stat.ctime) : undefined;
  }

  /** Returns an editor showing the file in source mode (Live Preview included), preferring the active tab. */
  private sourceEditorFor(file: TFile): Editor | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const views = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView);
    if (active) views.unshift(active);
    const v = views.find((view) => view.file?.path === file.path && view.getMode() === "source");
    return v ? v.editor : null;
  }

  /** Current text: from an open editor if there is one (it may be unsaved), otherwise from disk. */
  private async currentText(file: TFile): Promise<string> {
    const editor = this.sourceEditorFor(file);
    return editor ? editor.getValue() : this.app.vault.cachedRead(file);
  }

  private findEntry(ref: SessionRef): ActiveEntry | undefined {
    return this.active.find((a) => a.path === ref.path && a.start === ref.start);
  }

  /** Target of the finish command: the newest active session in the current note, else the newest overall. */
  private preferredActive(): ActiveEntry | undefined {
    const here = this.app.workspace.getActiveFile()?.path;
    const inHere = this.active.filter((a) => a.path === here);
    return inHere[inHere.length - 1] ?? this.active[this.active.length - 1];
  }

  /** Copies topic, mode and pause state from the block into the entry. Returns whether anything changed. */
  private syncEntry(a: ActiveEntry, s: Session): boolean {
    const open = openPause(s);
    const pausedAt = open ? formatStamp(open.from) : null;
    const paused = pausedMs(s, open ? open.from.getTime() : Number.POSITIVE_INFINITY);
    if (a.topic === s.topic && a.mode === s.mode && (a.pausedMs ?? 0) === paused && (a.pausedAt ?? null) === pausedAt) return false;
    a.topic = s.topic;
    a.mode = s.mode;
    a.pausedMs = paused;
    a.pausedAt = pausedAt;
    return true;
  }

  /**
   * Adds a rendered active block to the list, or updates its topic/mode/pause state.
   * This way hand-written blocks also show in the status bar and get alerts.
   */
  private observeActive(path: string, s: Session): void {
    const ref = { path, start: formatStamp(s.start) };
    let entry = this.findEntry(ref);
    if (entry) {
      if (!this.syncEntry(entry, s)) return;
    } else {
      entry = { ...ref, topic: s.topic, mode: s.mode };
      this.syncEntry(entry, s);
      this.active.push(entry);
    }
    void this.persist();
    this.tick();
  }

  // ───────────────────────── starting ─────────────────────────

  private async startFromRibbon(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a note first to start a session.");
      return;
    }
    if (view.getMode() !== "source") {
      // Switch from reading view to editing so the block can be inserted at the cursor.
      await view.setState({ ...view.getState(), mode: "source" }, { history: false });
    }
    await this.startFromEditor(view.editor, view, this.settings.defaultMode);
  }

  async startFromEditor(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, mode: SessionMode): Promise<void> {
    const file = ctx.file;
    if (!file) {
      new Notice("A session can only be started inside a note.");
      return;
    }

    const selection = editor.getSelection().replace(/\s+/g, " ").trim().slice(0, 200);
    const input = await new TopicModal(this.app, selection, file.basename, mode).ask();
    if (input === null) return; // cancelled
    // The note may have been deleted, or the view switched to another note, while the modal was open.
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile) || ctx.file?.path !== file.path) {
      new Notice("The note changed while the dialog was open; no session was started.");
      return;
    }
    const topic = input || file.basename;

    const now = new Date();
    now.setMilliseconds(0);
    // If a second session starts within the same second, keep start times unique (blocks are found by start).
    const taken = new Set(findBlocks(editor.getValue(), this.fileDay(file.path)).map((b) => formatStamp(b.session.start)));
    for (const a of this.active) taken.add(a.start);
    while (taken.has(formatStamp(now))) now.setSeconds(now.getSeconds() + 1);

    const session: Session = { topic, start: now, end: null, mode, pauses: [], extra: [] };
    const block = buildBlock(session);
    // Dry run first: if the block can't be placed cleanly here, change nothing (not even
    // the previous sessions).
    const before = editor.getValue();
    const preview = applyInsert(before, planInsert(before, editor.getCursor("to").line, block));
    if (!findBlockByStart(preview, now, this.fileDay(file.path))) {
      new Notice("A session can't be placed on this line. Click an empty line and try again.");
      return;
    }

    if (this.settings.autoStopPrevious) {
      for (const entry of [...this.active]) await this.stopSession(entry, now);
    }

    this.insertBlock(editor, block);
    // Safety net: only track the session if the inserted block can actually be found again.
    if (!findBlockByStart(editor.getValue(), now, this.fileDay(file.path))) {
      new Notice("The session block couldn't be placed here. Try an empty line outside other blocks.");
      return;
    }

    const entry: ActiveEntry = { path: file.path, start: formatStamp(now), topic, mode };
    if (!this.findEntry(entry)) this.active.push(entry);
    await this.persist();
    this.tick();
  }

  /**
   * Inserts the block at the cursor (see planInsert: empty line → replaced, otherwise below;
   * kept inside callouts; moved below a code block the cursor is in). One replaceRange means
   * one undo step. The cursor moves to the empty line below the block.
   */
  private insertBlock(editor: Editor, block: string): void {
    const plan = planInsert(editor.getValue(), editor.getCursor("to").line, block);
    editor.replaceRange(plan.text, plan.from, plan.to);
    editor.setCursor(plan.cursor);
  }

  // ───────────────────────── editing a session's block ─────────────────────────

  /**
   * Applies a planned edit to the note. If the note is open in source mode, the editor is used
   * (cursor and undo history are preserved); otherwise the file is updated with vault.process.
   * Returns whether the block was found, and the note's text afterwards.
   */
  private async editBlock(file: TFile, plan: (text: string) => BlockEdit | null): Promise<{ found: boolean; text: string }> {
    const editor = this.sourceEditorFor(file);
    if (editor) {
      const edit = plan(editor.getValue());
      if (edit && !edit.unchanged) {
        const replacement = edit.lines.map((l) => l + "\n").join("");
        editor.replaceRange(replacement, { line: edit.fromLine, ch: 0 }, { line: edit.toLine, ch: 0 });
      }
      return { found: !!edit, text: editor.getValue() };
    }
    let found = false;
    const text = await this.app.vault.process(file, (current) => {
      const edit = plan(current);
      if (!edit) return current;
      found = true;
      return applyEdit(current, edit); // unchanged edits return the text as is
    });
    return { found, text };
  }

  /** Looks up the note and start time of a session; forgets the session if the note is gone. */
  private async locate(ref: SessionRef): Promise<{ file: TFile; start: Date; dayOf: Date } | null> {
    const start = parseStamp(ref.start);
    const file = this.app.vault.getAbstractFileByPath(ref.path);
    if (!start || !(file instanceof TFile)) {
      new Notice("The session's note was not found; it was removed from active sessions.");
      await this.forget(ref);
      return null;
    }
    return { file, start, dayOf: new Date(file.stat.ctime) };
  }

  // ───────────────────────── finishing ─────────────────────────

  /**
   * Finishes the session at `end`: writes end and duration into the block and removes it from the active list.
   * A paused session ends at the moment it was paused. Returns true on success.
   */
  async stopSession(ref: SessionRef, end: Date = new Date()): Promise<boolean> {
    const at = await this.locate(ref);
    if (!at) return false;
    const { file, start, dayOf } = at;

    const endAt = new Date(Math.max(end.getTime(), start.getTime()));
    endAt.setMilliseconds(0);

    let found = false;
    try {
      found = (await this.editBlock(file, (text) => planFinish(text, start, endAt, dayOf))).found;
    } catch (e) {
      console.error("[timebox] could not finish session", e);
      new Notice("Couldn't finish the session: an error occurred while updating the note.");
      return false;
    }

    if (!found) {
      new Notice("This session's block was not found in the note; it was removed from active sessions.");
    }
    await this.forget(ref);
    return found;
  }

  // ───────────────────────── pausing and breaks ─────────────────────────

  /** Applies `change` to a running session's block and refreshes the active entry from the result. */
  private async changeSession(ref: SessionRef, change: (s: Session) => Session): Promise<boolean> {
    const at = await this.locate(ref);
    if (!at) return false;
    const { file, start, dayOf } = at;

    let result: { found: boolean; text: string };
    try {
      result = await this.editBlock(file, (text) => planChange(text, start, change, dayOf));
    } catch (e) {
      console.error("[timebox] could not update session", e);
      new Notice("Couldn't update the session: an error occurred while updating the note.");
      return false;
    }

    const session = result.found ? findBlockByStart(result.text, start, dayOf)?.session : undefined;
    if (!session) {
      new Notice("This session's block was not found in the note; it was removed from active sessions.");
      await this.forget(ref);
      return false;
    }
    if (session.end) await this.forget(ref); // finished by hand in the meantime
    else this.observeActive(ref.path, session);
    return true;
  }

  /** Starts a break: writes a "pause:" line. The timer and the pomodoro phase stand still until resumed. */
  pauseSession(ref: SessionRef, at: Date = nowSecond()): Promise<boolean> {
    return this.changeSession(ref, (s) => pauseAt(s, at));
  }

  /** Ends the current break: writes a "resume:" line. */
  resumeSession(ref: SessionRef, at: Date = nowSecond()): Promise<boolean> {
    return this.changeSession(ref, (s) => resumeAt(s, at));
  }

  /** Marks the time between `from` and `to` as a break after the fact. */
  addBreakTo(ref: SessionRef, from: Date, to: Date): Promise<boolean> {
    const floor = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
    return this.changeSession(ref, (s) => addBreak(s, floor(from), floor(to)));
  }

  /** Asks when the work really ended and finishes the session at that time. */
  async promptFinishAt(ref: SessionRef): Promise<void> {
    const start = parseStamp(ref.start);
    if (!start) return;
    const at = await new FinishAtModal(this.app, this.findEntry(ref)?.topic || "Session", start).ask();
    if (at) await this.stopSession(ref, at);
  }

  /** Asks how long the user was away and counts that time, ending now, as a break. */
  async promptBreak(ref: SessionRef): Promise<void> {
    const minutes = await new BreakModal(this.app, this.findEntry(ref)?.topic || "Session").ask();
    if (!minutes) return;
    const now = nowSecond();
    await this.addBreakTo(ref, new Date(now.getTime() - minutes * 60_000), now);
  }

  /** Runs `onPick` on the only active session, or lets the user choose when there are several. */
  private chooseSession(placeholder: string, onPick: (a: ActiveEntry) => void): void {
    if (this.active.length === 1) onPick(this.active[0]);
    else if (this.active.length > 1) new SessionSuggestModal(this.app, [...this.active].reverse(), onPick, placeholder).open();
  }

  // ───────────────────────── away detection ─────────────────────────

  /**
   * Called when nothing ran between `from` and `to` (the computer slept, or Obsidian was closed)
   * while sessions were running. Asks whether that time should count as a break.
   */
  private async askAway(from: number, to: number): Promise<void> {
    const running = this.active.filter((a) => !a.pausedAt && (parseStamp(a.start)?.getTime() ?? to) < to);
    if (running.length === 0 || this.awayOpen) return;
    const firstStart = Math.min(...running.map((a) => parseStamp(a.start)?.getTime() ?? to));
    const since = new Date(Math.max(from, firstStart));
    this.awayOpen = true;
    try {
      const choice = await new AwayModal(this.app, since, new Date(to), running.map((a) => a.topic || "Session")).ask();
      if (choice !== "break") return;
      for (const a of running) await this.addBreakTo(a, since, new Date(to));
    } finally {
      this.awayOpen = false;
    }
  }

  private async checkAwayOnStartup(): Promise<void> {
    const seen = this.lastSeen();
    const limit = this.settings.awayAfter * 60_000;
    const now = Date.now();
    this.markSeen();
    if (seen !== null && limit > 0 && now - seen >= limit) await this.askAway(seen, now);
  }

  private async forget(ref: SessionRef): Promise<void> {
    const before = this.active.length;
    this.active = this.active.filter((a) => !(a.path === ref.path && a.start === ref.start));
    this.lastPhase.delete(keyOf(ref));
    this.lastRemind.delete(keyOf(ref));
    if (this.active.length !== before) await this.persist();
    this.tick();
  }

  // ───────────────────────── housekeeping ─────────────────────────

  private onRename(file: TAbstractFile, oldPath: string): void {
    let changed = false;
    for (const a of this.active) {
      if (a.path !== oldPath) continue;
      const oldKey = keyOf(a);
      a.path = file.path;
      for (const memo of [this.lastPhase, this.lastRemind]) {
        const v = memo.get(oldKey);
        memo.delete(oldKey);
        if (v !== undefined) memo.set(keyOf(a), v);
      }
      changed = true;
    }
    if (changed) {
      void this.persist();
      this.tick();
    }
  }

  private onDelete(file: TAbstractFile): void {
    const gone = this.active.filter((a) => a.path === file.path);
    if (gone.length === 0) return;
    for (const a of gone) {
      this.lastPhase.delete(keyOf(a));
      this.lastRemind.delete(keyOf(a));
    }
    this.active = this.active.filter((a) => a.path !== file.path);
    void this.persist();
    this.tick();
  }

  /**
   * Drops sessions that are no longer in their note or were finished by hand, and picks up
   * pauses typed by hand (or synced from another device) in notes that aren't rendered.
   */
  private async pruneActive(): Promise<void> {
    if (this.active.length === 0) return;
    this.markSeen();
    let synced = false;
    const keep: ActiveEntry[] = [];
    for (const a of this.active) {
      const file = this.app.vault.getAbstractFileByPath(a.path);
      const start = parseStamp(a.start);
      if (!(file instanceof TFile) || !start) continue;
      try {
        const block = findBlockByStart(await this.currentText(file), start, new Date(file.stat.ctime));
        if (block && !block.session.end) {
          keep.push(a);
          if (this.syncEntry(a, block.session)) synced = true;
        }
      } catch {
        keep.push(a); // couldn't read it; leave it alone this round
      }
    }
    // Filter the current list so entries added/removed meanwhile aren't overwritten.
    const keepKeys = new Set(keep.map(keyOf));
    const snapshot = new Set(this.active.map(keyOf));
    const next = this.active.filter((a) => keepKeys.has(keyOf(a)) || !snapshot.has(keyOf(a)));
    if (next.length !== this.active.length || synced) {
      for (const a of this.active) {
        if (next.includes(a)) continue;
        this.lastPhase.delete(keyOf(a));
        this.lastRemind.delete(keyOf(a));
      }
      this.active = next;
      await this.persist();
      this.tick();
    }
  }

  // ───────────────────────── per-second update ─────────────────────────

  private tick(): void {
    const now = Date.now();
    const cfg = pomodoroConfig(this.settings);

    // A long gap since the previous tick means the computer slept (timers don't run then).
    const gap = now - this.lastTick;
    this.lastTick = now;
    const awayLimit = this.settings.awayAfter * 60_000;
    const wasAway = awayLimit > 0 && gap >= awayLimit;
    if (wasAway) void this.askAway(now - gap, now);

    // Phase-change alerts
    for (const a of this.active) {
      if (a.mode !== "pomodoro") continue;
      if (!parseStamp(a.start)) continue;
      const phase = pomodoroPhase(entryWorked(a, now), cfg);
      const key = keyOf(a);
      const prev = this.lastPhase.get(key);
      this.lastPhase.set(key, phase.index);
      // Stay quiet the first time a session is seen (e.g. Obsidian just started); alert only on real transitions.
      if (prev === undefined || phase.index <= prev) continue;

      const topic = a.topic || "Session";
      const minutes = Math.round(phase.phaseLength / 60_000);
      const done = `${phase.completedWork} ${phase.completedWork === 1 ? "pomodoro" : "pomodoros"} done`;
      const body =
        phase.kind === "work"
          ? `Pomodoro ${phase.pomodoro} started (${minutes} min)`
          : `${PHASE_LABEL[phase.kind]} started (${minutes} min) · ${done}`;
      this.alerts.notify(`${PHASE_EMOJI[phase.kind]} ${topic}`, body, {
        sound: this.settings.sound,
        system: this.settings.systemNotification,
        breakTone: phase.kind !== "work",
      });
    }

    // Long-session reminders: every `remindAfter` minutes of work
    const every = this.settings.remindAfter * 60_000;
    if (every > 0) {
      for (const a of [...this.active]) {
        if (a.pausedAt) continue;
        const count = Math.floor(entryWorked(a, now) / every);
        const key = keyOf(a);
        const prev = this.lastRemind.get(key);
        this.lastRemind.set(key, count);
        // Quiet the first time a session is seen, and after a sleep (the away dialog covers that).
        if (prev === undefined || count <= prev || wasAway) continue;
        void this.onLongSession(a, count * every);
      }
    }

    this.renderStatus(now);
  }

  /** A session has been running for a long time: remind, pause or finish it, depending on the setting. */
  private async onLongSession(a: ActiveEntry, workedFor: number): Promise<void> {
    const topic = a.topic || "Session";
    const length = formatDuration(workedFor);
    const opts = { sound: this.settings.sound, system: this.settings.systemNotification, breakTone: true };
    if (this.settings.remindAction === "pause") {
      if (await this.pauseSession(a)) this.alerts.notify(`⏸ ${topic}`, `Paused after ${length} of work. Resume it when you're back.`, opts);
    } else if (this.settings.remindAction === "finish") {
      if (await this.stopSession(a)) this.alerts.notify(`⏹ ${topic}`, `Finished after ${length} of work.`, opts);
    } else {
      this.alerts.notify(`⏰ ${topic}`, `Running for ${length}. Pause or finish it if you've stopped.`, opts);
    }
  }

  /** The session shown in the status bar: the newest running one, else the newest paused one. */
  private statusEntry(): ActiveEntry | undefined {
    for (let i = this.active.length - 1; i >= 0; i--) if (!this.active[i].pausedAt) return this.active[i];
    return this.active[this.active.length - 1];
  }

  /** "🍅 Focus 12:10" or "⏱ 42:13"; a paused session shows ⏸ instead of the phase icon. */
  private timerText(a: ActiveEntry, now: number): string {
    const worked = entryWorked(a, now);
    if (a.mode === "pomodoro") {
      const p = pomodoroPhase(worked, pomodoroConfig(this.settings));
      return `${a.pausedAt ? "⏸" : PHASE_EMOJI[p.kind]} ${PHASE_LABEL[p.kind]} ${formatTimer(p.phaseLength - p.elapsedInPhase)}`;
    }
    return `${a.pausedAt ? "⏸" : "⏱"} ${formatTimer(worked)}`;
  }

  private renderStatus(now: number): void {
    const el = this.statusEl;
    if (!el) return;
    const a = this.statusEntry();
    if (!this.settings.statusBar || !a || !parseStamp(a.start)) {
      el.toggle(false);
      return;
    }
    el.toggle(true);

    let text = `${this.timerText(a, now)} · ${a.topic || "Session"}`;
    if (this.active.length > 1) text += ` (+${this.active.length - 1})`;
    el.setText(text);
    el.setAttr("aria-label", this.active.length > 1 ? "Show active sessions" : `Open session note: ${a.path}`);
    el.setAttr("data-tooltip-position", "top");
  }

  /** One session: open its note. Several: show a menu of them. */
  private onStatusClick(evt: MouseEvent): void {
    if (this.active.length <= 1) {
      const a = this.statusEntry();
      if (a) void this.openSessionNote(a);
      return;
    }
    const menu = new Menu();
    const now = Date.now();
    for (const a of [...this.active].reverse()) {
      menu.addItem((item) =>
        item
          .setTitle(`${this.timerText(a, now)} · ${a.topic || "Session"}`)
          .setIcon(a.pausedAt ? "pause" : "timer")
          .onClick(() => void this.openSessionNote(a))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Finish a session…")
        .setIcon("square")
        .onClick(() => this.chooseSession("Finish which session?", (a) => void this.stopSession(a)))
    );
    menu.showAtMouseEvent(evt);
  }

  private async openSessionNote(a: ActiveEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(a.path);
    if (!(file instanceof TFile)) {
      new Notice("The session's note was not found.");
      return;
    }
    // If the note is already open in a tab, switch to it; otherwise open it.
    const open = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => l.view instanceof MarkdownView && l.view.file?.path === file.path);
    if (open) {
      this.app.workspace.setActiveLeaf(open, { focus: true });
    } else {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}

function isActiveEntry(x: unknown): x is ActiveEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.path === "string" &&
    typeof e.start === "string" &&
    parseStamp(e.start) !== null &&
    typeof e.topic === "string" &&
    (e.mode === "simple" || e.mode === "pomodoro") &&
    (e.pausedMs === undefined || (typeof e.pausedMs === "number" && Number.isFinite(e.pausedMs) && e.pausedMs >= 0)) &&
    (e.pausedAt === undefined || e.pausedAt === null || (typeof e.pausedAt === "string" && parseStamp(e.pausedAt) !== null))
  );
}
