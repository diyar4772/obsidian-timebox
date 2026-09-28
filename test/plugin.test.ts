// Integration tests for src/main.ts, run against the fake Obsidian API in test/obsidian-mock.ts.
// They cover the flows that touch notes: inserting blocks, finishing sessions through the
// editor and through vault.process, the active list, rename/delete, and cleanup.

import * as assert from "assert";
import { Editor, MarkdownView, Notice, TFile } from "obsidian";
import TimeboxPlugin from "../src/main";
import { TopicModal } from "../src/ui/topic-modal";

(globalThis as any).window = { setInterval: () => 0 };

// The modal answers with whatever the current test sets here (null = cancelled).
let modalAnswer: string | null = "Math Methods";
let modalInitial = "";
(TopicModal.prototype as any).ask = async function (this: any) {
  modalInitial = this.initial;
  return modalAnswer;
};

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
  const renderBlock = (path: string, source: string) =>
    plugin.processors.get("timebox")(source, {}, { sourcePath: path, addChild() {} });
  const text = (p: string) => {
    const v = views.find((x) => x.file.path === p);
    return v && v.getMode() === "source" ? v.editor.getValue() : disk[p];
  };
  return { plugin, app, disk, tfiles, views, handlers, renderBlock, text };
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
