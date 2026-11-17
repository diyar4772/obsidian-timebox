// Integration tests for src/main.ts, run against the fake Obsidian API in test/obsidian-mock.ts.
// They cover the flows that touch notes: inserting blocks, finishing sessions through the
// editor and through vault.process, the active list, rename/delete, and cleanup.

import * as assert from "assert";
import { Editor, FuzzySuggestModal, MarkdownView, Menu, Notice, TFile } from "obsidian";
import { formatStamp, parseBreak } from "../src/core";

/** The "paused:" total written in a note, in ms (null if there is none). */
const pausedIn = (text: string) => {
  const m = text.match(/\npaused: (.+)\n/);
  return m ? parseBreak(m[1]) : null;
};
import { AwayModal, BreakModal, FinishAtModal } from "../src/ui/modals";
import TimeboxPlugin from "../src/main";
import { TopicModal } from "../src/ui/topic-modal";
import { DEFAULT_SETTINGS, TimeboxSettingTab } from "../src/settings";

(globalThis as any).window = { setInterval: () => 0 };

// The modal answers with whatever the current test sets here (null = cancelled).
let modalAnswer: string | null = "Math Methods";
let modalInitial = "";
(TopicModal.prototype as any).ask = async function (this: any) {
  modalInitial = this.initial;
  return modalAnswer;
};

// The pause dialogs answer the same way.
let finishAtAnswer: Date | null = null;
let breakAnswer: number | null = null;
let awayAnswer: "break" | "keep" | null = null;
let awayAsked: { from: Date; to: Date; topics: string[] }[] = [];
(FinishAtModal.prototype as any).ask = async () => finishAtAnswer;
(BreakModal.prototype as any).ask = async () => breakAnswer;
(AwayModal.prototype as any).ask = async function (this: any) {
  awayAsked.push({ from: this.from, to: this.to, topics: this.topics });
  return awayAnswer;
};

const MINUTE = 60_000;
/** A stamp `minutes` before now (the pause features work with the real clock). */
const ago = (minutes: number) => formatStamp(new Date(Math.floor(Date.now() / 1000) * 1000 - minutes * MINUTE));
const at = (stamp: string) => new Date(stamp.replace(" ", "T")).getTime();

const STAMP = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/;

/** Builds a plugin with a fake vault: `open` files have an editor, the rest live on "disk". */
async function setup(files: Record<string, string>, open: string[] = [], mode: "source" | "preview" = "source") {
  const disk: Record<string, string> = { ...files };
  const tfiles: Record<string, TFile> = {};
  for (const p of Object.keys(files)) tfiles[p] = new TFile(p);
  const views = open.map((p) => new MarkdownView(tfiles[p], new Editor(files[p]), mode));
  const handlers: Record<string, (...a: any[]) => void> = {};
  const app: any = {
    vault: {
      getAbstractFileByPath: (p: string) => tfiles[p] ?? null,
      cachedRead: async (f: TFile) => disk[f.path],
      process: async (f: TFile, fn: (s: string) => string) => (disk[f.path] = fn(disk[f.path])),
      on: (name: string, fn: (...a: any[]) => void) => ((handlers[name] = fn), {}),
    },
    workspace: {
      getActiveViewOfType: () => views[0] ?? null,
      getLeavesOfType: () => views.map((v) => ({ view: v })),
      getActiveFile: () => views[0]?.file ?? null,
      onLayoutReady: () => {},
    },
  };
  const plugin: any = new (TimeboxPlugin as any)(app);
  await plugin.onload();
  const rendered: any[] = [];
  const renderBlock = (path: string, source: string, section?: { text: string; lineStart: number; lineEnd: number }) =>
    plugin.processors.get("timebox")(source, {}, {
      sourcePath: path,
      addChild: (c: any) => rendered.push(c),
      ...(section ? { getSectionInfo: () => section } : {}),
    });
  const text = (p: string) => {
    const v = views.find((x) => x.file.path === p);
    return v && v.getMode() === "source" ? v.editor.getValue() : disk[p];
  };
  return { plugin, app, disk, tfiles, views, handlers, renderBlock, rendered, text };
}

const tests: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

test("start on a non-empty line inserts below; cursor lands on an empty line under the block", async () => {
  modalAnswer = "Math Methods";
  const { plugin, views } = await setup({ "A.md": "# A\nline one\nline three" }, ["A.md"]);
  const ed = views[0].editor;
  ed.cursor = { line: 1, ch: 3 };
  await plugin.startFromEditor(ed, views[0], "pomodoro");
  const lines = ed.getValue().split("\n");
  assert.deepEqual(lines.slice(0, 2), ["# A", "line one"]);
  assert.equal(lines[2], "```timebox");
  assert.equal(lines[3], "topic: Math Methods");
  assert.match(lines[4], new RegExp("^start: " + STAMP.source + "$"));
  assert.equal(lines[5], "mode: pomodoro");
  assert.equal(lines[6], "```");
  assert.equal(lines[7], "");
  assert.equal(lines[8], "line three");
  assert.deepEqual(ed.cursor, { line: 7, ch: 0 });
  assert.equal(plugin.active.length, 1);
  assert.equal(plugin.data.active.length, 1, "active list is persisted");
});

test("start on an empty last line replaces it and adds a line to type on", async () => {
  modalAnswer = "";
  const { plugin, views } = await setup({ "Notes/Physics.md": "intro\n" }, ["Notes/Physics.md"]);
  const ed = views[0].editor;
  ed.cursor = { line: 1, ch: 0 };
  await plugin.startFromEditor(ed, views[0], "simple");
  const lines = ed.getValue().split("\n");
  assert.equal(lines[1], "```timebox");
  assert.equal(lines[2], "topic: Physics", "empty topic falls back to the note name");
  assert.equal(lines[4], "```");
  assert.equal(lines[5], "");
  assert.equal(lines.length, 6);
  assert.deepEqual(ed.cursor, { line: 5, ch: 0 });
  assert.ok(!ed.getValue().includes("mode:"), "simple sessions have no mode line");
});

test("cancelling the modal changes nothing; the selection pre-fills the topic", async () => {
  modalAnswer = null;
  const { plugin, views } = await setup({ "A.md": "x" }, ["A.md"]);
  views[0].editor.selection = "  Linear\n  Algebra ";
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  assert.equal(modalInitial, "Linear Algebra");
  assert.equal(views[0].editor.getValue(), "x");
  assert.equal(plugin.active.length, 0);
});

test("starting a new session finishes open ones: other note via vault.process, same note via editor", async () => {
  modalAnswer = "First";
  const other = "# B\n```timebox\ntopic: Old\nstart: 2026-09-28 09:00:00\nnote: p. 42\n```\nend of B";
  const { plugin, views, disk } = await setup({ "A.md": "# A\n", "B.md": other }, ["A.md"]);
  plugin.active.push({ path: "B.md", start: "2026-09-28 09:00:00", topic: "Old", mode: "simple" });

  const ed = views[0].editor;
  ed.cursor = { line: 1, ch: 0 };
  await plugin.startFromEditor(ed, views[0], "simple");
  assert.match(disk["B.md"], /start: 2026-09-28 09:00:00\nend: .+\nduration: .+\nnote: p\. 42\n```\nend of B$/);
  assert.equal(plugin.active.length, 1);

  modalAnswer = "Second";
  ed.cursor = { line: ed.lastLine(), ch: 0 };
  await plugin.startFromEditor(ed, views[0], "simple");
  const text = ed.getValue();
  assert.match(text, /topic: First\nstart: .+\nend: .+\nduration: .+\n```/);
  assert.match(text, /topic: Second\nstart: .+\n```/);
  assert.equal(plugin.active.length, 1);
  assert.equal(plugin.active[0].topic, "Second");
  // both started within the same second: the second start was bumped so they stay unique
  const starts = [...text.matchAll(/start: (.+)/g)].map((m) => m[1]);
  assert.equal(new Set(starts).size, starts.length);
});

test("finishing a note open in reading view goes through vault.process", async () => {
  const note = "```timebox\nstart: 2026-09-28 10:00:00\n```";
  const { plugin, disk, views } = await setup({ "R.md": note }, ["R.md"], "preview");
  const ok = await plugin.stopSession({ path: "R.md", start: "2026-09-28 10:00:00" }, new Date(2026, 8, 28, 10, 42));
  assert.equal(ok, true);
  assert.equal(disk["R.md"], "```timebox\nstart: 2026-09-28 10:00:00\nend: 2026-09-28 10:42:00\nduration: 42m\n```");
  assert.equal(views[0].editor.getValue(), note, "the hidden editor isn't touched");
});

test("a bare start time is matched using the note's creation day", async () => {
  const { plugin, disk } = await setup({ "T.md": "```timebox\nstart: 10:00\n```" });
  const ok = await plugin.stopSession({ path: "T.md", start: "2026-09-28 10:00:00" }, new Date(2026, 8, 28, 10, 30));
  assert.equal(ok, true);
  assert.equal(disk["T.md"], "```timebox\nstart: 2026-09-28 10:00:00\nend: 2026-09-28 10:30:00\nduration: 30m\n```");
});

test("finish command prefers the active session in the current note", async () => {
  const blockA = "```timebox\nstart: 2026-09-28 10:00:00\n```";
  const blockB = "```timebox\nstart: 2026-09-28 11:00:00\n```";
  const { plugin, text } = await setup({ "A.md": blockA, "B.md": blockB }, ["A.md"]);
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  plugin.active.push({ path: "B.md", start: "2026-09-28 11:00:00", topic: "", mode: "simple" });
  const cmd = plugin.commands.find((c: any) => c.id === "finish-active-session");
  assert.equal(cmd.checkCallback(true), true);
  cmd.checkCallback(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(text("A.md"), /end: /);
  assert.ok(!text("B.md").includes("end:"));
  assert.deepEqual(
    plugin.active.map((a: any) => a.path),
    ["B.md"]
  );
});

test("finish command is hidden when nothing is active", async () => {
  const { plugin } = await setup({ "A.md": "" }, ["A.md"]);
  const cmd = plugin.commands.find((c: any) => c.id === "finish-active-session");
  assert.equal(cmd.checkCallback(true), false);
});

test("a missing block or note is reported and dropped from the active list", async () => {
  Notice.log = [];
  const { plugin } = await setup({ "A.md": "no blocks here" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  plugin.active.push({ path: "Gone.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  assert.equal(await plugin.stopSession(plugin.active[0]), false);
  assert.equal(await plugin.stopSession(plugin.active[0]), false);
  assert.equal(plugin.active.length, 0);
  assert.equal(Notice.log.length, 2);
});

test("rendering an open block tracks it; a finished or broken block is not tracked", async () => {
  const { plugin, renderBlock } = await setup({ "H.md": "" });
  renderBlock("H.md", "topic: Hand-written\nstart: 2026-09-28 10:00");
  assert.deepEqual(plugin.active, [
    { path: "H.md", start: "2026-09-28 10:00:00", topic: "Hand-written", mode: "simple" },
  ]);
  renderBlock("H.md", "topic: Renamed\nstart: 2026-09-28 10:00\nmode: pomodoro");
  assert.equal(plugin.active.length, 1);
  assert.equal(plugin.active[0].topic, "Renamed");
  assert.equal(plugin.active[0].mode, "pomodoro");
  renderBlock("H.md", "start: 2026-09-28 11:00\nend: 12:00");
  renderBlock("H.md", "topic: broken");
  renderBlock("Board.canvas", "start: 2026-09-28 12:00");
  assert.equal(plugin.active.length, 1);
});

test("rename updates the path; delete removes the session", async () => {
  const { plugin, handlers } = await setup({ "A.md": "" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  handlers.rename(new TFile("Archive/A.md"), "A.md");
  assert.equal(plugin.active[0].path, "Archive/A.md");
  handlers.delete(new TFile("Archive/A.md"));
  assert.equal(plugin.active.length, 0);
});

test("cleanup drops finished and missing sessions and keeps running ones (unsaved editor text counts)", async () => {
  const files = {
    "Run.md": "```timebox\nstart: 2026-09-28 10:00:00\n```",
    "Done.md": "```timebox\nstart: 2026-09-28 10:00:00\nend: 11:00\n```",
    "Empty.md": "",
    "Open.md": "",
  };
  const { plugin, views } = await setup(files, ["Open.md"]);
  // typed into the editor, not saved to disk yet
  views[0].editor.text = "```timebox\nstart: 2026-09-28 12:00:00\n```";
  for (const [path, start] of [
    ["Run.md", "2026-09-28 10:00:00"],
    ["Done.md", "2026-09-28 10:00:00"],
    ["Empty.md", "2026-09-28 10:00:00"],
    ["Nowhere.md", "2026-09-28 10:00:00"],
    ["Open.md", "2026-09-28 12:00:00"],
  ]) {
    plugin.active.push({ path, start, topic: "", mode: "simple" });
  }
  await plugin.pruneActive();
  assert.deepEqual(
    plugin.active.map((a: any) => a.path),
    ["Run.md", "Open.md"]
  );
});

test("corrupted data.json falls back to defaults", async () => {
  const { plugin } = await setup({});
  plugin.data = {
    settings: { work: -3, short: "5", long: 1e9, longEvery: 2.5, sound: "yes", statusBar: false, defaultMode: "x" },
    active: [null, 42, { path: "A.md" }, { path: "A.md", start: "bad", topic: "", mode: "simple" },
      { path: "B.md", start: "2026-09-28 10:00:00", topic: "ok", mode: "pomodoro" }],
  };
  await plugin.loadState();
  assert.equal(plugin.settings.work, 25);
  assert.equal(plugin.settings.short, 5);
  assert.equal(plugin.settings.long, 15);
  assert.equal(plugin.settings.longEvery, 4);
  assert.equal(plugin.settings.sound, true);
  assert.equal(plugin.settings.statusBar, false);
  assert.equal(plugin.settings.defaultMode, "simple");
  assert.deepEqual(
    plugin.active.map((a: any) => a.path),
    ["B.md"]
  );
});

test("status bar shows the newest session and hides when the setting is off", async () => {
  const { plugin } = await setup({ "A.md": "" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "Math", mode: "simple" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 11:00:00", topic: "Physics", mode: "pomodoro" });
  plugin.tick();
  assert.equal(plugin.statusEl.shown, true);
  assert.match(plugin.statusEl.text, /^(🍅 Focus|☕ Short break|☕ Long break) \d.* · Physics \(\+1\)$/);
  plugin.settings.statusBar = false;
  plugin.tick();
  assert.equal(plugin.statusEl.shown, false);
});

test("an end typed by hand is not overwritten when a new session starts", async () => {
  modalAnswer = "New";
  const b = "```timebox\ntopic: Old\nstart: 2026-09-28 09:00:00\nend: 2026-09-28 09:25:00\n```";
  const { plugin, disk, views } = await setup({ "A.md": "# A\n", "B.md": b }, ["A.md"]);
  plugin.active.push({ path: "B.md", start: "2026-09-28 09:00:00", topic: "Old", mode: "simple" });
  views[0].editor.cursor = { line: 1, ch: 0 };
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  assert.equal(disk["B.md"], b);
  assert.deepEqual(
    plugin.active.map((a: any) => a.path),
    ["A.md"]
  );
});

test("finishing targets the running copy when a finished block has the same start", async () => {
  const t = "```timebox\nstart: 2026-09-28 09:00:00\nend: 2026-09-28 09:25:00\n```\n\n```timebox\nstart: 2026-09-28 09:00:00\n```";
  const { plugin, disk } = await setup({ "B.md": t });
  plugin.active.push({ path: "B.md", start: "2026-09-28 09:00:00", topic: "", mode: "simple" });
  await plugin.stopSession(plugin.active[0], new Date(2026, 8, 28, 11));
  assert.ok(disk["B.md"].startsWith("```timebox\nstart: 2026-09-28 09:00:00\nend: 2026-09-28 09:25:00\n```"));
  assert.ok(disk["B.md"].endsWith("end: 2026-09-28 11:00:00\nduration: 2h\n```"));
});

test("starting inside a callout keeps the block in the callout; inside a code block it goes below", async () => {
  modalAnswer = "T";
  const { plugin, views } = await setup({ "C.md": "> [!note]\n> line\n> more", "J.md": "```js\nlet a = 1\n\n```\nafter" }, ["C.md", "J.md"]);
  plugin.settings.autoStopPrevious = false;
  views[0].editor.cursor = { line: 1, ch: 3 };
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  assert.match(views[0].editor.getValue(), /^> \[!note\]\n> line\n> ```timebox\n> topic: T\n> start: .+\n> ```\n> \n> more$/);
  views[1].editor.cursor = { line: 2, ch: 0 };
  await plugin.startFromEditor(views[1].editor, views[1], "simple");
  assert.match(views[1].editor.getValue(), /^```js\nlet a = 1\n\n```\n```timebox\ntopic: T\nstart: .+\n```\n\nafter$/);
  assert.equal(plugin.active.length, 2);
});

test("no session starts if the note was deleted while the dialog was open", async () => {
  Notice.log = [];
  modalAnswer = "T";
  const { plugin, views, tfiles } = await setup({ "A.md": "x" }, ["A.md"]);
  delete (tfiles as any)["A.md"];
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  assert.equal(views[0].editor.getValue(), "x");
  assert.equal(plugin.active.length, 0);
  assert.equal(Notice.log.length, 1);
});

test("a block never closed before the end of the note renders an error and isn't tracked", async () => {
  const { plugin, renderBlock, rendered } = await setup({ "U.md": "" });
  const text = "intro\n```timebox\nstart: 2026-09-28 10:00\n";
  renderBlock("U.md", "start: 2026-09-28 10:00\n", { text, lineStart: 1, lineEnd: 3 });
  assert.equal(rendered[0].result.ok, false);
  assert.match(rendered[0].result.error, /no closing fence/);
  assert.equal(plugin.active.length, 0);
  // a closed block at the very end is fine
  const closed = "```timebox\nstart: 2026-09-28 10:00\n```";
  renderBlock("U.md", "start: 2026-09-28 10:00", { text: closed, lineStart: 0, lineEnd: 2 });
  assert.equal(rendered[1].result.ok, true);
  assert.equal(plugin.active.length, 1);
});

test("starting inside a code block closed by its callout puts the session outside it and finishes the previous one", async () => {
  modalAnswer = "T";
  const { plugin, views } = await setup({ "Q.md": "> ```js\n> code\ntext\n```timebox\nstart: 2026-09-28 09:00:00\n```" }, ["Q.md"]);
  plugin.active.push({ path: "Q.md", start: "2026-09-28 09:00:00", topic: "", mode: "simple" });
  views[0].editor.cursor = { line: 1, ch: 2 };
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  const txt = views[0].editor.getValue();
  assert.match(txt, /^> ```js\n> code\n```timebox\ntopic: T\nstart: .+\n```\n\ntext\n/);
  assert.match(txt, /start: 2026-09-28 09:00:00\nend: /, "the previous session is finished");
  assert.equal(plugin.active.length, 1);
  assert.equal(plugin.active[0].topic, "T");
});

test("valid blocks in a callout or list at the end of the note render as bars (section = container)", async () => {
  const { plugin, renderBlock, rendered } = await setup({ "N.md": "" });
  const callout = "# N\n> [!note]\n> ```timebox\n> start: 2026-09-28 10:00\n> ```\n> some text";
  renderBlock("N.md", "start: 2026-09-28 10:00", { text: callout, lineStart: 1, lineEnd: 5 });
  const list = "- a\n  ```timebox\n  start: 2026-09-28 11:00\n  ```\n- b";
  renderBlock("N.md", "start: 2026-09-28 11:00", { text: list, lineStart: 0, lineEnd: 4 });
  assert.equal(rendered[0].result.ok, true);
  assert.equal(rendered[1].result.ok, true);
  assert.equal(plugin.active.length, 2);
});

test("a session started in a callout at the end of the note renders as a bar", async () => {
  modalAnswer = "T";
  const { plugin, views, renderBlock, rendered } = await setup({ "C.md": "> [!note] Title\n> body" }, ["C.md"]);
  views[0].editor.cursor = { line: 0, ch: 3 };
  await plugin.startFromEditor(views[0].editor, views[0], "simple");
  const text = views[0].editor.getValue();
  const lines = text.split("\n");
  const source = lines.filter((l) => /^> (topic|start):/.test(l)).map((l) => l.slice(2)).join("\n");
  renderBlock("C.md", source, { text, lineStart: 0, lineEnd: lines.length - 1 });
  assert.equal(rendered[0].result.ok, true, text);
  assert.equal(plugin.active.length, 1);
});

test("declarative settings: every setting is defined, and saving keeps the active list", async () => {
  const { plugin, app } = await setup({ "A.md": "" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "x", mode: "simple" });
  await plugin.saveSettings();
  const tab: any = new TimeboxSettingTab(app, plugin);

  // every settings key has a control (keeps getSettingDefinitions in sync with the settings)
  const keys: string[] = [];
  const walk = (items: any[]) => items.forEach((i) => (i.items ? walk(i.items) : i.control && keys.push(i.control.key)));
  walk(tab.getSettingDefinitions());
  assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_SETTINGS).sort());

  await tab.setControlValue("work", 50);
  await tab.setControlValue("defaultMode", "pomodoro");
  assert.equal(tab.getControlValue("work"), 50);
  assert.equal(plugin.data.settings.work, 50);
  assert.equal(plugin.data.settings.defaultMode, "pomodoro");
  assert.equal(plugin.data.active.length, 1, "the active list survives a settings change");

  // invalid values never reach the stored settings
  await tab.setControlValue("short", 0);
  await tab.setControlValue("defaultMode", "nonsense");
  assert.equal(plugin.settings.short, 5);
  assert.equal(plugin.settings.defaultMode, "simple");

  // number validation messages
  const work = tab.getSettingDefinitions()[2].items[1].control;
  assert.equal(work.validate(25), undefined);
  assert.match(work.validate(2.5), /whole number/);
  assert.match(work.validate(601), /whole number/);
});

// ─────────────── pausing ───────────────

test("pause and resume through the editor: lines are written and the active entry follows", async () => {
  const start = ago(30);
  const { plugin, views } = await setup({ "A.md": "# A\n```timebox\ntopic: T\nstart: " + start + "\nnote: keep\n```\nafter" }, ["A.md"]);
  const ref = { path: "A.md", start };
  const ed = views[0].editor;
  ed.cursor = { line: 6, ch: 2 };

  assert.equal(await plugin.pauseSession(ref), true);
  assert.match(ed.getValue(), new RegExp("start: " + start + "\npause: " + STAMP.source + "\nnote: keep\n```\nafter$"));
  assert.deepEqual(ed.cursor, { line: 7, ch: 2 }, "the cursor moves down with the text");
  assert.equal(plugin.active.length, 1, "pausing tracks an untracked block");
  assert.match(plugin.active[0].pausedAt, STAMP);
  assert.equal(plugin.data.active[0].pausedAt, plugin.active[0].pausedAt, "the pause state is persisted");

  const paused = ed.getValue();
  await plugin.pauseSession(ref);
  assert.equal(ed.getValue(), paused, "pausing twice changes nothing");

  assert.equal(await plugin.resumeSession(ref), true);
  // the open pause becomes part of the total: no "resume:" line, the block stays short
  assert.equal(ed.getValue(), "# A\n```timebox\ntopic: T\nstart: " + start + "\nnote: keep\n```\nafter", "a pause of under a second adds nothing");
  assert.equal(plugin.active[0].pausedAt, null);
  const resumed = ed.getValue();
  await plugin.resumeSession(ref);
  assert.equal(ed.getValue(), resumed, "resuming twice changes nothing");
});

test("pausing a closed note and a note in reading view goes through vault.process", async () => {
  const start = ago(10);
  const note = "```timebox\nstart: " + start + "\n```";
  const { plugin, disk, views } = await setup({ "C.md": note, "R.md": note }, ["R.md"], "preview");
  for (const path of ["C.md", "R.md"]) {
    assert.equal(await plugin.pauseSession({ path, start }), true);
    assert.match(disk[path], new RegExp("^```timebox\nstart: " + start + "\npause: " + STAMP.source + "\n```$"));
  }
  assert.equal(views[0].editor.getValue(), note, "the hidden editor isn't touched");
  assert.equal(plugin.active.length, 2);
});

test("finishing a paused session ends it where the break began", async () => {
  const start = ago(60);
  const pause = ago(20);
  const { plugin, disk } = await setup({ "A.md": "```timebox\nstart: " + start + "\npause: " + pause + "\n```" });
  assert.equal(await plugin.stopSession({ path: "A.md", start }), true);
  assert.equal(disk["A.md"], "```timebox\nstart: " + start + "\nend: " + pause + "\nduration: 40m\n```");
});

test("a finished session is never paused; a missing block is reported and dropped", async () => {
  const done = "```timebox\nstart: 2026-09-28 10:00:00\nend: 2026-09-28 11:00:00\nduration: 1h\n```";
  const { plugin, disk } = await setup({ "A.md": done, "B.md": "nothing here" });
  plugin.active.push({ path: "A.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  plugin.active.push({ path: "B.md", start: "2026-09-28 10:00:00", topic: "", mode: "simple" });
  await plugin.pauseSession({ path: "A.md", start: "2026-09-28 10:00:00" });
  assert.equal(disk["A.md"], done);
  Notice.log.length = 0;
  assert.equal(await plugin.pauseSession({ path: "B.md", start: "2026-09-28 10:00:00" }), false);
  assert.match(Notice.log[0], /block was not found/);
  assert.equal(plugin.active.length, 0, "finished and missing sessions leave the active list");
});

test("pause command toggles the preferred session and is hidden when nothing is active", async () => {
  const start = ago(5);
  const { plugin, views } = await setup({ "A.md": "```timebox\nstart: " + start + "\n```" }, ["A.md"]);
  const cmd = plugin.commands.find((c: any) => c.id === "pause-resume-active-session");
  assert.equal(cmd.checkCallback(true), false);
  plugin.active.push({ path: "A.md", start, topic: "", mode: "simple" });
  assert.equal(cmd.checkCallback(true), true);
  cmd.checkCallback(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(views[0].editor.getValue(), /\npause: /);
  cmd.checkCallback(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!views[0].editor.getValue().includes("pause"), "resumed: the open pause line is gone");
  assert.equal(plugin.active[0].pausedAt, null);
});

test("status bar: a paused session shows ⏸ and a frozen time; a running one is preferred", async () => {
  const { plugin, renderBlock } = await setup({ "A.md": "", "B.md": "" });
  renderBlock("A.md", "topic: Paused\nstart: " + ago(60) + "\npaused: 10m\npause: " + ago(10));
  assert.equal(plugin.statusEl.text, "⏸ 40:00 · Paused");
  assert.equal(plugin.active[0].pausedMs, 10 * MINUTE);
  renderBlock("B.md", "topic: Running\nstart: " + ago(90) + "\npause: " + ago(80) + "\nresume: " + ago(20));
  assert.match(plugin.statusEl.text, /^⏱ 30:0\d · Running \(\+1\)$/);
  // pomodoro: the phase stands still while paused (25 min focus, 20 worked → 05:00 left)
  const { plugin: p2, renderBlock: r2 } = await setup({ "A.md": "" });
  r2("A.md", "topic: P\nmode: pomodoro\nstart: " + ago(60) + "\npause: " + ago(40));
  assert.equal(p2.statusEl.text, "⏸ Focus 05:00 · P");
});

test("cleanup picks up a pause typed by hand in a note that isn't rendered", async () => {
  const start = ago(30);
  const { plugin, disk } = await setup({ "A.md": "```timebox\nstart: " + start + "\n```" });
  plugin.active.push({ path: "A.md", start, topic: "", mode: "simple" });
  disk["A.md"] = "```timebox\ntopic: New\nstart: " + start + "\npause: " + ago(10) + "\n```";
  await plugin.pruneActive();
  assert.equal(plugin.active[0].pausedAt, ago(10));
  assert.equal(plugin.active[0].topic, "New");
  assert.equal(plugin.data.active[0].pausedAt, ago(10));
});

test("finish at an earlier time: the chosen end is written and a later pause is dropped", async () => {
  const start = ago(120);
  const body = "```timebox\nstart: " + start + "\npaused: 10m\npause: " + ago(30) + "\n```";
  const { plugin, disk } = await setup({ "A.md": body });
  plugin.active.push({ path: "A.md", start, topic: "T", mode: "simple" });
  finishAtAnswer = null;
  await plugin.promptFinishAt({ path: "A.md", start });
  assert.equal(disk["A.md"], body, "cancelling changes nothing");
  finishAtAnswer = new Date(at(ago(60)));
  await plugin.promptFinishAt({ path: "A.md", start });
  assert.equal(
    disk["A.md"],
    "```timebox\nstart: " + start + "\nend: " + ago(60) + "\nduration: 50m\npaused: 10m\n```"
  );
  assert.equal(plugin.active.length, 0);
});

test("add a break: the last N minutes are added to the total and the session keeps running", async () => {
  const start = ago(45);
  const { plugin, views } = await setup({ "A.md": "```timebox\nstart: " + start + "\n```" }, ["A.md"]);
  breakAnswer = null;
  await plugin.promptBreak({ path: "A.md", start });
  assert.ok(!views[0].editor.getValue().includes("pause"));
  breakAnswer = 15;
  await plugin.promptBreak({ path: "A.md", start });
  assert.equal(views[0].editor.getValue(), "```timebox\nstart: " + start + "\npaused: 15m\n```");
  assert.equal(plugin.active[0].pausedAt, null);
  assert.equal(plugin.active[0].pausedMs, 15 * MINUTE);
  // longer than the session: clipped to its start, and the total never exceeds the session
  breakAnswer = 600;
  await plugin.promptBreak({ path: "A.md", start });
  assert.ok(pausedIn(views[0].editor.getValue())! <= 61 * MINUTE);
});

test("away: after a long gap between ticks, running sessions can count it as a break", async () => {
  const start = ago(60);
  const pausedBody = "```timebox\nstart: " + start + "\npause: " + ago(50) + "\n```";
  const { plugin, disk, renderBlock } = await setup({ "A.md": "```timebox\ntopic: Run\nstart: " + start + "\n```", "P.md": pausedBody });
  renderBlock("A.md", "topic: Run\nstart: " + start);
  renderBlock("P.md", "start: " + start + "\npause: " + ago(50));
  const flush = () => new Promise((r) => setTimeout(r, 5));

  // a short gap: nothing is asked
  awayAsked = [];
  plugin.lastTick = Date.now() - 2 * MINUTE;
  plugin.tick();
  await flush();
  assert.equal(awayAsked.length, 0);

  awayAnswer = "keep";
  plugin.lastTick = Date.now() - 42 * MINUTE;
  plugin.tick();
  await flush();
  assert.equal(awayAsked.length, 1);
  assert.deepEqual(awayAsked[0].topics, ["Run"], "paused sessions aren't asked about");
  assert.ok(Math.abs(awayAsked[0].to.getTime() - awayAsked[0].from.getTime() - 42 * MINUTE) < 2000);
  assert.ok(!disk["A.md"].includes("pause"), "keeping the time changes nothing");

  awayAnswer = "break";
  plugin.lastTick = Date.now() - 42 * MINUTE;
  plugin.tick();
  await flush();
  assert.ok(Math.abs(pausedIn(disk["A.md"])! - 42 * MINUTE) <= 1000, "the gap was written as a break");
  assert.equal(disk["P.md"], pausedBody, "the paused session is left alone");

  // switched off
  plugin.settings.awayAfter = 0;
  awayAsked = [];
  plugin.lastTick = Date.now() - 500 * MINUTE;
  plugin.tick();
  await flush();
  assert.equal(awayAsked.length, 0);
});

test("away on startup: the time Obsidian was closed is offered, clipped to the session's start", async () => {
  const start = ago(30);
  const { plugin, app, disk } = await setup({ "A.md": "```timebox\nstart: " + start + "\n```" });
  plugin.active.push({ path: "A.md", start, topic: "T", mode: "simple" });
  const store: Record<string, unknown> = {};
  awayAsked = [];
  awayAnswer = "break";

  // Obsidian older than 1.8.7 has no local storage API: the feature is skipped
  await plugin.checkAwayOnStartup();
  assert.equal(awayAsked.length, 0);

  app.loadLocalStorage = (k: string) => store[k] ?? null;
  app.saveLocalStorage = (k: string, v: unknown) => (store[k] = v);
  await plugin.checkAwayOnStartup();
  assert.equal(awayAsked.length, 0, "nothing stored yet");
  assert.ok(Number(store["timebox-last-seen"]) > 0, "the visit is recorded");

  store["timebox-last-seen"] = String(Date.now() - 20 * MINUTE);
  await plugin.checkAwayOnStartup();
  assert.equal(awayAsked.length, 1);
  assert.ok(Math.abs(pausedIn(disk["A.md"])! - 20 * MINUTE) <= 1000);

  // closed since before the session existed (e.g. started on another device): from its start
  disk["A.md"] = "```timebox\nstart: " + start + "\n```";
  await plugin.pruneActive();
  store["timebox-last-seen"] = String(Date.now() - 500 * MINUTE);
  await plugin.checkAwayOnStartup();
  assert.equal(formatStamp(awayAsked[1].from), start);
  assert.ok(Math.abs(pausedIn(disk["A.md"])! - 30 * MINUTE) <= 1000, "clipped to the session's start");
});

test("long session limit: quiet when first seen, then reminds, pauses or finishes", async () => {
  const realNow = Date.now;
  try {
    for (const action of ["notify", "pause", "finish"] as const) {
      const start = ago(170);
      const { plugin, disk } = await setup({ "A.md": "```timebox\ntopic: Long\nstart: " + start + "\n```" });
      const alerts: string[] = [];
      plugin.alerts.notify = (title: string, body: string) => alerts.push(`${title} | ${body}`);
      plugin.settings.remindAction = action;
      plugin.active.push({ path: "A.md", start, topic: "Long", mode: "simple" });

      plugin.tick();
      assert.equal(alerts.length, 0);
      // 11 minutes later the session passes 180 minutes
      Date.now = () => realNow() + 11 * MINUTE;
      plugin.lastTick = Date.now();
      plugin.tick();
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(alerts.length, 1, action);
      plugin.tick();
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(alerts.length, 1, "only once per limit");
      Date.now = realNow;

      if (action === "notify") {
        assert.match(alerts[0], /⏰ Long \| Running for 3h/);
        assert.ok(!disk["A.md"].includes("pause") && !disk["A.md"].includes("end"));
      } else if (action === "pause") {
        assert.match(alerts[0], /⏸ Long \| Paused after 3h/);
        assert.match(disk["A.md"], /\npause: /);
        assert.match(plugin.active[0].pausedAt, STAMP);
      } else {
        assert.match(alerts[0], /⏹ Long \| Finished after 3h/);
        assert.match(disk["A.md"], /\nend: .+\nduration: 2h 50m\n```$/);
        assert.equal(plugin.active.length, 0);
      }
    }

    // off, and never for paused sessions
    const start = ago(170);
    const { plugin } = await setup({ "A.md": "" });
    const alerts: string[] = [];
    plugin.alerts.notify = (title: string) => alerts.push(title);
    plugin.active.push({ path: "A.md", start, topic: "Off", mode: "simple" });
    plugin.active.push({ path: "A.md", start: ago(169), topic: "Paused", mode: "simple", pausedAt: ago(1), pausedMs: 0 });
    plugin.settings.remindAfter = 0;
    plugin.tick();
    Date.now = () => realNow() + 11 * MINUTE;
    plugin.lastTick = Date.now();
    plugin.tick();
    assert.equal(alerts.length, 0);
    plugin.settings.remindAfter = 180;
    plugin.tick();
    Date.now = () => realNow() + 400 * MINUTE;
    plugin.lastTick = Date.now();
    plugin.tick();
    assert.deepEqual(alerts, ["⏰ Off"]);
  } finally {
    Date.now = realNow;
  }
});

test("several sessions: the status bar opens a menu, and finishing asks which one", async () => {
  const { plugin, disk, app } = await setup({
    "A.md": "```timebox\ntopic: One\nstart: " + ago(20) + "\n```",
    "B.md": "```timebox\ntopic: Two\nstart: " + ago(10) + "\npause: " + ago(5) + "\n```",
  });
  plugin.active.push({ path: "A.md", start: ago(20), topic: "One", mode: "simple" });
  await plugin.pruneActive();
  const opened: string[] = [];
  app.workspace.getLeaf = () => ({ openFile: async (f: TFile) => void opened.push(f.path) });
  Menu.last = null;
  plugin.onStatusClick({});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(Menu.last, null, "a single session opens its note instead of a menu");
  assert.deepEqual(opened, ["A.md"]);

  plugin.active.push({ path: "B.md", start: ago(10), topic: "Two", mode: "simple" });
  await plugin.pruneActive();
  plugin.onStatusClick({});
  const menu = Menu.last!;
  assert.deepEqual(menu.items.map((i) => i.icon), ["pause", "timer", "square"]);
  assert.match(menu.items[0].title, /^⏸ 05:00 · Two$/);
  assert.match(menu.items[1].title, /^⏱ 20:0\d · One$/);
  menu.items[0].click();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(opened, ["A.md", "B.md"]);

  const cmd = plugin.commands.find((c: any) => c.id === "choose-session-to-finish");
  assert.equal(cmd.checkCallback(true), true);
  cmd.checkCallback(false);
  const picker: any = FuzzySuggestModal.last;
  assert.deepEqual(picker.getItems().map((a: any) => a.topic), ["Two", "One"]);
  assert.equal(picker.getItemText(picker.getItems()[1]), "One · A");
  picker.onChooseItem(picker.getItems()[1]);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(disk["A.md"], /\nend: /);
  assert.ok(!disk["B.md"].includes("end:"));
  assert.deepEqual(plugin.active.map((a: any) => a.topic), ["Two"]);
});

test("data.json from 1.0.x loads; broken pause fields are dropped; new settings are validated", async () => {
  const { plugin } = await setup({});
  plugin.data = {
    settings: { remindAfter: -1, awayAfter: 2000, remindAction: "explode" },
    active: [
      { path: "A.md", start: "2026-09-28 10:00:00", topic: "old", mode: "simple" },
      { path: "B.md", start: "2026-09-28 10:00:00", topic: "ok", mode: "simple", pausedMs: 60000, pausedAt: "2026-09-28 10:30:00" },
      { path: "C.md", start: "2026-09-28 10:00:00", topic: "bad", mode: "simple", pausedAt: "soon" },
      { path: "D.md", start: "2026-09-28 10:00:00", topic: "bad", mode: "simple", pausedMs: -5 },
    ],
  };
  await plugin.loadState();
  assert.deepEqual(plugin.active.map((a: any) => a.topic), ["old", "ok"]);
  assert.equal(plugin.settings.remindAfter, 180);
  assert.equal(plugin.settings.awayAfter, 5);
  assert.equal(plugin.settings.remindAction, "notify");
  plugin.data = { settings: { remindAfter: 0, awayAfter: 0, remindAction: "pause" }, active: [] };
  await plugin.loadState();
  assert.equal(plugin.settings.remindAfter, 0);
  assert.equal(plugin.settings.awayAfter, 0);
  assert.equal(plugin.settings.remindAction, "pause");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}`);
      console.log(String(e instanceof Error ? e.stack ?? e.message : e).replace(/^/gm, "      "));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} plugin tests passed`);
  if (failed > 0) process.exit(1);
})();
