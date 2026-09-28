import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TAbstractFile, TFile } from "obsidian";
import {
  BLOCK_LANG,
  PHASE_EMOJI,
  PHASE_LABEL,
  ParseResult,
  Session,
  SessionMode,
  applyEdit,
  applyInsert,
  buildBlock,
  findBlockByStart,
  findBlocks,
  formatStamp,
  formatTimer,
  isUnclosedAtEnd,
  parseBlock,
  parseStamp,
  planFinish,
  planInsert,
  pomodoroPhase,
} from "./core";
import { TimeboxSettingTab, TimeboxSettings, pomodoroConfig, sanitizeSettings } from "./settings";
import { Alerts } from "./ui/alerts";
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
}

/** Enough information to find a session in a file. */
export type SessionRef = Pick<ActiveEntry, "path" | "start">;

interface PluginData {
  settings: TimeboxSettings;
  active: ActiveEntry[];
}

const TICK_MS = 1000;
const PRUNE_MS = 30_000;

const keyOf = (r: SessionRef) => `${r.path}\u0000${r.start}`;

export default class TimeboxPlugin extends Plugin {
  settings!: TimeboxSettings;
  /** Active sessions in the order they were started (last = newest). */
  active: ActiveEntry[] = [];

  private statusEl: HTMLElement | null = null;
  /** Last seen pomodoro phase index per session, to detect phase changes. Not persisted. */
  private lastPhase = new Map<string, number>();
  private alerts = new Alerts();

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

    this.addRibbonIcon("timer", "Start session", () => void this.startFromRibbon());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("timebox-status", "mod-clickable");
    this.registerDomEvent(this.statusEl, "click", () => void this.openStatusSession());

    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
    this.registerInterval(window.setInterval(() => void this.pruneActive(), PRUNE_MS));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));

    this.addSettingTab(new TimeboxSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => void this.pruneActive());
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

  /**
   * Adds a rendered active block to the list, or updates its topic/mode.
   * This way hand-written blocks also show in the status bar and get alerts.
   */
  private observeActive(path: string, s: Session): void {
    const ref = { path, start: formatStamp(s.start) };
    const existing = this.findEntry(ref);
    if (existing) {
      if (existing.topic === s.topic && existing.mode === s.mode) return;
      existing.topic = s.topic;
      existing.mode = s.mode;
    } else {
      this.active.push({ ...ref, topic: s.topic, mode: s.mode });
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

    const session: Session = { topic, start: now, end: null, mode, extra: [] };
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

  // ───────────────────────── finishing ─────────────────────────

  /**
   * Finishes the session at `end`: writes end and duration into the block and removes it from the active list.
   * If the note is open in source mode, the editor is used (cursor and undo history are preserved);
   * otherwise the file is updated with vault.process. Returns true on success.
   */
  async stopSession(ref: SessionRef, end: Date = new Date()): Promise<boolean> {
    const start = parseStamp(ref.start);
    const file = this.app.vault.getAbstractFileByPath(ref.path);
    if (!start || !(file instanceof TFile)) {
      new Notice("The session's note was not found; it was removed from active sessions.");
      await this.forget(ref);
      return false;
    }

    const endAt = new Date(Math.max(end.getTime(), start.getTime()));
    endAt.setMilliseconds(0);
    const dayOf = new Date(file.stat.ctime);

    let found = false;
    try {
      const editor = this.sourceEditorFor(file);
      if (editor) {
        const edit = planFinish(editor.getValue(), start, endAt, dayOf);
        if (edit) found = true;
        if (edit && !edit.unchanged) {
          const replacement = edit.lines.map((l) => l + "\n").join("");
          editor.replaceRange(replacement, { line: edit.fromLine, ch: 0 }, { line: edit.toLine, ch: 0 });
        }
      } else {
        await this.app.vault.process(file, (text) => {
          const edit = planFinish(text, start, endAt, dayOf);
          if (!edit) return text;
          found = true;
          return applyEdit(text, edit); // unchanged edits return the text as is
        });
      }
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

  private async forget(ref: SessionRef): Promise<void> {
    const before = this.active.length;
    this.active = this.active.filter((a) => !(a.path === ref.path && a.start === ref.start));
    this.lastPhase.delete(keyOf(ref));
    if (this.active.length !== before) await this.persist();
    this.tick();
  }

  // ───────────────────────── housekeeping ─────────────────────────

  private onRename(file: TAbstractFile, oldPath: string): void {
    let changed = false;
    for (const a of this.active) {
      if (a.path !== oldPath) continue;
      const phase = this.lastPhase.get(keyOf(a));
      this.lastPhase.delete(keyOf(a));
      a.path = file.path;
      if (phase !== undefined) this.lastPhase.set(keyOf(a), phase);
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
    for (const a of gone) this.lastPhase.delete(keyOf(a));
    this.active = this.active.filter((a) => a.path !== file.path);
    void this.persist();
    this.tick();
  }

  /** Drops sessions that are no longer in their note or were finished by hand. */
  private async pruneActive(): Promise<void> {
    if (this.active.length === 0) return;
    const keep: ActiveEntry[] = [];
    for (const a of this.active) {
      const file = this.app.vault.getAbstractFileByPath(a.path);
      const start = parseStamp(a.start);
      if (!(file instanceof TFile) || !start) continue;
      try {
        const block = findBlockByStart(await this.currentText(file), start, new Date(file.stat.ctime));
        if (block && !block.session.end) keep.push(a);
      } catch {
        keep.push(a); // couldn't read it; leave it alone this round
      }
    }
    // Filter the current list so entries added/removed meanwhile aren't overwritten.
    const keepKeys = new Set(keep.map(keyOf));
    const snapshot = new Set(this.active.map(keyOf));
    const next = this.active.filter((a) => keepKeys.has(keyOf(a)) || !snapshot.has(keyOf(a)));
    if (next.length !== this.active.length) {
      for (const a of this.active) if (!next.includes(a)) this.lastPhase.delete(keyOf(a));
      this.active = next;
      await this.persist();
      this.tick();
    }
  }

  // ───────────────────────── per-second update ─────────────────────────

  private tick(): void {
    const now = Date.now();
    const cfg = pomodoroConfig(this.settings);

    // Phase-change alerts
    for (const a of this.active) {
      if (a.mode !== "pomodoro") continue;
      const start = parseStamp(a.start);
      if (!start) continue;
      const phase = pomodoroPhase(now - start.getTime(), cfg);
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

    this.renderStatus(now);
  }

  private statusEntry(): ActiveEntry | undefined {
    return this.active[this.active.length - 1];
  }

  private renderStatus(now: number): void {
    const el = this.statusEl;
    if (!el) return;
    const a = this.statusEntry();
    const start = a ? parseStamp(a.start) : null;
    if (!this.settings.statusBar || !a || !start) {
      el.toggle(false);
      return;
    }
    el.toggle(true);

    const elapsed = now - start.getTime();
    const topic = a.topic || "Session";
    let text: string;
    if (a.mode === "pomodoro") {
      const p = pomodoroPhase(elapsed, pomodoroConfig(this.settings));
      text = `${PHASE_EMOJI[p.kind]} ${PHASE_LABEL[p.kind]} ${formatTimer(p.phaseLength - p.elapsedInPhase)} · ${topic}`;
    } else {
      text = `⏱ ${formatTimer(elapsed)} · ${topic}`;
    }
    if (this.active.length > 1) text += ` (+${this.active.length - 1})`;
    el.setText(text);
    el.setAttr("aria-label", `Open session note: ${a.path}`);
    el.setAttr("data-tooltip-position", "top");
  }

  private async openStatusSession(): Promise<void> {
    const a = this.statusEntry();
    if (!a) return;
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
    (e.mode === "simple" || e.mode === "pomodoro")
  );
}
