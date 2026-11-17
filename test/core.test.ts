// Tests for src/core.ts. `npm test` bundles this file with esbuild and runs it in Node.
// Dates are built in the local time zone, so the tests pass in any time zone.

import * as assert from "assert";
import {
  addBreak,
  finishAt,
  formatBreak,
  parseBreak,
  lastOccurrence,
  openPause,
  pauseAt,
  pausedMs,
  planChange,
  resumeAt,
  workedMs,
  applyEdit,
  applyInsert,
  buildBlock,
  completedPomodoros,
  dayDiff,
  findBlockByStart,
  findBlocks,
  formatClock,
  formatDuration,
  formatStamp,
  formatTimer,
  isUnclosedAtEnd,
  parseBlock,
  parseStamp,
  planFinish,
  planInsert,
  pomodoroPhase,
  replaceBlock,
  rewriteBody,
  serializeBlock,
  Session,
} from "../src/core";

const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const MIN = 60_000;
const cfg = { work: 25, short: 5, long: 15, longEvery: 4 };
const d = (y: number, mo: number, day: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, day, h, mi, s);

function ok(source: string, dayOf?: Date): Session {
  const r = parseBlock(source, dayOf);
  if (!r.ok) throw new Error("Unexpected parse error: " + r.error);
  return r.session;
}

// ─────────────── time parsing / formatting ───────────────

test("parseStamp: supported formats", () => {
  assert.equal(formatStamp(parseStamp("2026-09-28 18:29")!), "2026-09-28 18:29:00");
  assert.equal(formatStamp(parseStamp("2026-09-28 18:29:05")!), "2026-09-28 18:29:05");
  assert.equal(formatStamp(parseStamp("2026-09-28T08:05")!), "2026-09-28 08:05:00");
  assert.equal(formatStamp(parseStamp("28.09.2026 18:29")!), "2026-09-28 18:29:00");
  assert.equal(formatStamp(parseStamp("8.9.2026 7:05:09")!), "2026-09-08 07:05:09");
  assert.equal(formatStamp(parseStamp("18:29", d(2026, 9, 28))!), "2026-09-28 18:29:00");
  assert.equal(formatStamp(parseStamp("  18:29:30 ", d(2026, 1, 2))!), "2026-01-02 18:29:30");
});

test("parseStamp: invalid values return null", () => {
  assert.equal(parseStamp("last night"), null);
  assert.equal(parseStamp(""), null);
  assert.equal(parseStamp("25:00"), null);
  assert.equal(parseStamp("12:60"), null);
  assert.equal(parseStamp("31.02.2026 10:00"), null);
  assert.equal(parseStamp("2026-13-01 10:00"), null);
});

test("formatTimer / formatDuration / formatClock", () => {
  assert.equal(formatTimer(42 * MIN + 13_000), "42:13");
  assert.equal(formatTimer(65 * MIN + 9_000), "1:05:09");
  assert.equal(formatTimer(2 * MIN + 20_000), "02:20");
  assert.equal(formatTimer(-5000), "00:00");
  assert.equal(formatDuration(78 * MIN), "1h 18m");
  assert.equal(formatDuration(42 * MIN), "42m");
  assert.equal(formatDuration(120 * MIN), "2h");
  assert.equal(formatDuration(20_000), "< 1m");
  assert.equal(formatDuration(59 * MIN + 59_000), "59m");
  assert.equal(formatClock(d(2026, 9, 28, 7, 5)), "07:05");
});

test("dayDiff", () => {
  assert.equal(dayDiff(d(2026, 9, 28, 23, 40), d(2026, 9, 29, 0, 20)), 1);
  assert.equal(dayDiff(d(2026, 9, 28, 8), d(2026, 9, 28, 23)), 0);
  assert.equal(dayDiff(d(2026, 12, 31, 22), d(2027, 1, 2, 1)), 2);
});

// ─────────────── block parsing ───────────────

test("keys are case-insensitive", () => {
  const a = ok("Topic: Math Methods\nSTART: 2026-09-28 18:29\nMODE: Pomodoro");
  assert.equal(a.topic, "Math Methods");
  assert.equal(formatStamp(a.start), "2026-09-28 18:29:00");
  assert.equal(a.mode, "pomodoro");
  assert.equal(a.end, null);

  const b = ok("topic: Physics\nstart: 28.09.2026 10:00\nEnd: 11:30\nmode: simple");
  assert.equal(b.topic, "Physics");
  assert.equal(b.mode, "simple");
  assert.equal(formatStamp(b.end!), "2026-09-28 11:30:00");

  // unknown mode values fall back to simple
  assert.equal(ok("start: 2026-09-28 10:00\nmode: whatever").mode, "simple");
});

test("unrecognized lines are kept, the duration line is ignored", () => {
  const s = ok("topic: x\nnote: p. 42\nstart: 2026-09-28 10:00\nduration: 5h\nhttp://example.com\n");
  assert.deepEqual(s.extra, ["note: p. 42", "http://example.com"]);
  assert.equal(s.end, null);

  const t = ok("start: 10:00\nend: 10:45\nduration: 999h", d(2026, 9, 28));
  assert.equal(formatStamp(t.end!), "2026-09-28 10:45:00");
});

test("a bare start time uses the note's creation day", () => {
  const ctime = d(2026, 3, 15, 9, 12);
  const s = ok("start: 14:00", ctime);
  assert.equal(formatStamp(s.start), "2026-03-15 14:00:00");
});

test("midnight: a bare end time earlier than the start moves to the next day", () => {
  const s = ok("start: 2026-09-28 23:40\nend: 00:20");
  assert.equal(formatStamp(s.end!), "2026-09-29 00:20:00");
  assert.equal(formatDuration(s.end!.getTime() - s.start.getTime()), "40m");

  // month and year boundary
  const y = ok("start: 31.12.2026 23:30\nend: 01:15");
  assert.equal(formatStamp(y.end!), "2027-01-01 01:15:00");

  // bare start + bare end
  const t = ok("start: 22:00\nend: 02:00", d(2026, 9, 28));
  assert.equal(formatStamp(t.end!), "2026-09-29 02:00:00");
});

test("unreadable blocks give a clear error", () => {
  const cases: [string, RegExp][] = [
    ["topic: x", /Missing “start:”/],
    ["start:", /Missing “start:”/],
    ["start: tomorrow", /Can't read the start time/],
    ["start: 2026-09-28 10:00\nend: later", /Can't read the end time/],
    ["start: 2026-09-28 10:00\nend: 2026-09-27 10:00", /can't be before/],
  ];
  for (const [src, re] of cases) {
    const r = parseBlock(src);
    assert.ok(!r.ok, src);
    if (!r.ok) assert.match(r.error, re);
  }
});

// ─────────────── block writing ───────────────

test("serializeBlock / buildBlock", () => {
  const start = d(2026, 9, 28, 18, 29, 5);
  const end = d(2026, 9, 28, 19, 47, 5);
  assert.equal(
    buildBlock({ topic: "Math Methods", start, end: null, mode: "pomodoro", pausedMs: 0, pausedAt: null, extra: [] }),
    "```timebox\ntopic: Math Methods\nstart: 2026-09-28 18:29:05\nmode: pomodoro\n```"
  );
  assert.equal(
    serializeBlock({ topic: "Math Methods", start, end, mode: "pomodoro", pausedMs: 0, pausedAt: null, extra: ["note: p. 42"] }),
    "topic: Math Methods\nstart: 2026-09-28 18:29:05\nmode: pomodoro\n" +
      "end: 2026-09-28 19:47:05\nduration: 1h 18m\nnote: p. 42"
  );
  // a serialized block parses back to the same session
  const back = ok(serializeBlock({ topic: "A", start, end, mode: "simple", pausedMs: 0, pausedAt: null, extra: [] }));
  assert.equal(formatStamp(back.end!), formatStamp(end));
  assert.equal(back.mode, "simple");
});

test("rewriteBody: unrecognized lines stay in place, missing fields are inserted", () => {
  const start = d(2026, 9, 28, 10, 0);
  const end = d(2026, 9, 28, 11, 5);
  const body = ["Topic: Chemistry", "note: p. 42", "START: 10:00", "", "- another note"];
  const out = rewriteBody(body, { topic: "Chemistry", start, end, mode: "simple", pausedMs: 0, pausedAt: null, extra: [] });
  assert.deepEqual(out, [
    "topic: Chemistry",
    "note: p. 42",
    "start: 2026-09-28 10:00:00",
    "end: 2026-09-28 11:05:00",
    "duration: 1h 5m",
    "",
    "- another note",
  ]);

  // an existing end is updated in place; the stale duration is removed and rewritten
  const body2 = ["start: 2026-09-28 10:00", "duration: wrong", "end: 10:30", "note: x"];
  const out2 = rewriteBody(body2, { topic: "", start, end, mode: "simple", pausedMs: 0, pausedAt: null, extra: [] });
  // no "topic:" line is added when the topic is empty
  assert.deepEqual(out2, [
    "start: 2026-09-28 10:00:00",
    "end: 2026-09-28 11:05:00",
    "duration: 1h 5m",
    "note: x",
  ]);
});

// ─────────────── finding / replacing blocks in a file ───────────────

const START = d(2026, 9, 28, 18, 29, 5);
const END = d(2026, 9, 28, 19, 47, 5);

const NOTE = [
  "# Math Methods",
  "",
  "Fourier series",
  "```timebox",
  "topic: Math Methods",
  "start: 2026-09-28 18:29:05",
  "note: p. 42",
  "mode: pomodoro",
  "```",
  "- a note",
  "```python",
  'print("```timebox")',
  "```",
  "",
  "````markdown",
  "```timebox",
  "start: 2026-09-28 18:29:05",
  "```",
  "````",
  "last line",
].join("\n");

test("findBlocks: ignores blocks nested in other code blocks", () => {
  const blocks = findBlocks(NOTE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].openLine, 3);
  assert.equal(blocks[0].closeLine, 8);
  assert.equal(blocks[0].session.topic, "Math Methods");
});

test("replaceBlock: adds the end, leaves other content (other code blocks too) intact", () => {
  const cur = findBlocks(NOTE)[0].session;
  const out = replaceBlock(NOTE, START, { ...cur, end: END })!;
  assert.ok(out !== null);

  const expected = NOTE.replace(
    "note: p. 42\nmode: pomodoro\n```",
    "note: p. 42\nmode: pomodoro\nend: 2026-09-28 19:47:05\nduration: 1h 18m\n```"
  );
  assert.equal(out, expected);

  const again = findBlocks(out);
  assert.equal(again.length, 1);
  assert.equal(formatStamp(again[0].session.end!), "2026-09-28 19:47:05");
  assert.deepEqual(again[0].session.extra, ["note: p. 42"]);

  // non-matching start → null
  assert.equal(replaceBlock(NOTE, d(2020, 1, 1), cur), null);
});

test("planFinish + applyEdit give the same result as replaceBlock", () => {
  const edit = planFinish(NOTE, START, END)!;
  assert.equal(edit.fromLine, 4);
  assert.equal(edit.toLine, 8);
  const cur = findBlocks(NOTE)[0].session;
  assert.equal(applyEdit(NOTE, edit), replaceBlock(NOTE, START, { ...cur, end: END }));
});

test("multiple blocks: only the one with the matching start changes", () => {
  const text = [
    "```timebox",
    "topic: A",
    "start: 2026-09-28 09:00:00",
    "end: 2026-09-28 10:00:00",
    "duration: 1h",
    "```",
    "text in between",
    "~~~timebox",
    "topic: B",
    "start: 2026-09-28 10:00:00",
    "~~~",
    "",
    "````timebox",
    "topic: C",
    "start: 2026-09-28 11:00:00",
    "````",
  ].join("\n");
  const blocks = findBlocks(text);
  assert.deepEqual(
    blocks.map((b) => b.session.topic),
    ["A", "B", "C"]
  );

  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 10, 50))!);
  const after = findBlocks(out);
  assert.equal(formatStamp(after[0].session.end!), "2026-09-28 10:00:00");
  assert.equal(formatStamp(after[1].session.end!), "2026-09-28 10:50:00");
  assert.equal(after[2].session.end, null);
  assert.ok(out.includes("topic: B\nstart: 2026-09-28 10:00:00\nend: 2026-09-28 10:50:00\nduration: 50m\n~~~"));
  assert.ok(out.startsWith(text.split("text in between")[0]));
  assert.ok(out.endsWith("````timebox\ntopic: C\nstart: 2026-09-28 11:00:00\n````"));
});

test("fences: ~~~, 4+ backticks, a shorter fence doesn't close the block", () => {
  const text = "````timebox\nstart: 2026-09-28 10:00\n```\nnote: inner\n````\nafter";
  const b = findBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].closeLine, 4);
  assert.deepEqual(b[0].session.extra, ["```", "note: inner"]);

  // a ~~~ block isn't closed by ```
  const t2 = "~~~ timebox\nstart: 10:00\n```\n~~~~";
  assert.equal(findBlocks(t2, d(2026, 9, 28)).length, 1);

  // unclosed blocks don't count
  assert.equal(findBlocks("```timebox\nstart: 2026-09-28 10:00\n").length, 0);

  // extra words in the info string are fine; the language name is case-insensitive
  assert.equal(findBlocks("```Timebox extra\nstart: 2026-09-28 10:00\n```").length, 1);
  // a different language such as "timeboxes" doesn't match
  assert.equal(findBlocks("```timeboxes\nstart: 2026-09-28 10:00\n```").length, 0);
});

test("blockquoted (>) and indented blocks keep their prefix", () => {
  const text = "> [!note]\n> ```timebox\n> topic: Q\n> start: 2026-09-28 10:00\n>\n> ```\n> after";
  const out = replaceBlock(text, d(2026, 9, 28, 10), {
    topic: "Q",
    start: d(2026, 9, 28, 10),
    end: d(2026, 9, 28, 10, 30),
    mode: "simple",
    pausedMs: 0,
    pausedAt: null,
    extra: [],
  })!;
  assert.equal(
    out,
    "> [!note]\n> ```timebox\n> topic: Q\n> start: 2026-09-28 10:00:00\n> end: 2026-09-28 10:30:00\n" +
      "> duration: 30m\n>\n> ```\n> after"
  );

  const list = "- item\n  ```timebox\n  start: 2026-09-28 10:00\n  ```\n";
  const b = findBlocks(list);
  assert.equal(b.length, 1);
  assert.equal(b[0].prefix, "  ");
});

test("CRLF line endings are preserved", () => {
  const text = "a\r\n```timebox\r\nstart: 2026-09-28 10:00\r\n```\r\nb";
  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 10, 5))!);
  assert.equal(
    out,
    "a\r\n```timebox\r\nstart: 2026-09-28 10:00:00\r\nend: 2026-09-28 10:05:00\r\nduration: 5m\r\n```\r\nb"
  );
});

// ─────────────── pomodoro ───────────────

test("pomodoro: reference examples (25/5/15, long break every 4)", () => {
  assert.equal(pomodoroPhase(26 * MIN, cfg).kind, "short");
  assert.equal(pomodoroPhase(116 * MIN, cfg).kind, "long");

  const p131 = pomodoroPhase(131 * MIN, cfg);
  assert.equal(p131.kind, "work");
  assert.equal(p131.pomodoro, 5);

  assert.equal(completedPomodoros(78 * MIN, cfg), 2); // middle of the 3rd pomodoro
  assert.equal(pomodoroPhase(78 * MIN, cfg).pomodoro, 3);
  assert.equal(completedPomodoros(85 * MIN, cfg), 3);
});

test("pomodoro: phase fields", () => {
  assert.deepEqual(pomodoroPhase(0, cfg), {
    kind: "work",
    index: 0,
    pomodoro: 1,
    completedWork: 0,
    elapsedInPhase: 0,
    phaseLength: 25 * MIN,
  });
  assert.deepEqual(pomodoroPhase(27 * MIN, cfg), {
    kind: "short",
    index: 1,
    pomodoro: 1,
    completedWork: 1,
    elapsedInPhase: 2 * MIN,
    phaseLength: 5 * MIN,
  });
  assert.deepEqual(pomodoroPhase(116 * MIN, cfg), {
    kind: "long",
    index: 7,
    pomodoro: 4,
    completedWork: 4,
    elapsedInPhase: 1 * MIN,
    phaseLength: 15 * MIN,
  });
  const p = pomodoroPhase(131 * MIN, cfg);
  assert.equal(p.index, 8);
  assert.equal(p.completedWork, 4);
  assert.equal(p.elapsedInPhase, 1 * MIN);
  // exact boundaries: the break starts at minute 25, a new cycle at minute 130
  assert.equal(pomodoroPhase(25 * MIN, cfg).kind, "short");
  assert.equal(pomodoroPhase(25 * MIN - 1, cfg).kind, "work");
  assert.equal(pomodoroPhase(130 * MIN, cfg).index, 8);
  assert.equal(completedPomodoros(24 * MIN, cfg), 0);
  assert.equal(completedPomodoros(-5 * MIN, cfg), 0);
});

/** Simple step-by-step reference model. */
function naivePhase(ms: number, c: typeof cfg) {
  let t = 0;
  let index = 0;
  let done = 0;
  for (;;) {
    const w = c.work * MIN;
    if (ms < t + w) return { kind: "work", index, completedWork: done };
    t += w;
    index++;
    done++;
    const isLong = done % c.longEvery === 0;
    const b = (isLong ? c.long : c.short) * MIN;
    if (ms < t + b) return { kind: isLong ? "long" : "short", index, completedWork: done };
    t += b;
    index++;
  }
}

test("pomodoro: closed form matches the step-by-step model (several configs)", () => {
  const configs = [cfg, { work: 50, short: 10, long: 30, longEvery: 2 }, { work: 1, short: 1, long: 2, longEvery: 1 }];
  for (const c of configs) {
    let lastIndex = -1;
    for (let s = 0; s < 12 * 60 * 60; s += 17) {
      const got = pomodoroPhase(s * 1000, c);
      const want = naivePhase(s * 1000, c);
      assert.equal(got.kind, want.kind, `${JSON.stringify(c)} @${s}s`);
      assert.equal(got.index, want.index, `${JSON.stringify(c)} @${s}s`);
      assert.equal(got.completedWork, want.completedWork, `${JSON.stringify(c)} @${s}s`);
      assert.ok(got.index >= lastIndex, "phase index must never decrease");
      assert.ok(got.elapsedInPhase >= 0 && got.elapsedInPhase < got.phaseLength);
      lastIndex = got.index;
    }
  }
});

test("pomodoro: invalid settings fall back to safe defaults", () => {
  const p = pomodoroPhase(26 * MIN, { work: 0, short: NaN, long: -1, longEvery: 0 });
  assert.equal(p.kind, "short");
  assert.equal(p.phaseLength, 5 * MIN);
});

// ─────────────── regressions from the external review ───────────────

test("callout without a closing fence inside the quote: only quoted lines are touched", () => {
  const text = "> [!note]\n> ```timebox\n> start: 2026-09-28 10:00\n\nMy paragraph\n```js\nlet x = 1\n```\nafter";
  const b = findBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].closed, false);
  assert.equal(b[0].closeLine, 3, "the block ends where the quote ends");
  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 11))!);
  assert.equal(
    out,
    "> [!note]\n> ```timebox\n> start: 2026-09-28 10:00:00\n> end: 2026-09-28 11:00:00\n> duration: 1h\n" +
      "\nMy paragraph\n```js\nlet x = 1\n```\nafter"
  );
});

test("an unquoted fence after a quoted opening is not its closing fence", () => {
  const text = "> ```timebox\n> start: 2026-09-28 10:00\n```\ntext\n```";
  const b = findBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].closed, false);
  assert.deepEqual(b[0].body, ["start: 2026-09-28 10:00"]);
});

test("a list item's block ends when the list item ends", () => {
  const text = "- item\n  ```timebox\n  start: 2026-09-28 10:00\n\n  note: kept\nParagraph\n```\nafter";
  const b = findBlocks(text);
  assert.equal(b.length, 1);
  assert.equal(b[0].closeLine, 5);
  assert.deepEqual(b[0].body, ["start: 2026-09-28 10:00", "", "note: kept"]);
  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 10, 5))!);
  assert.ok(out.endsWith("\nParagraph\n```\nafter"), out);
  // a properly closed block in a list item still works
  const ok = "1. step\n   ```timebox\n   start: 2026-09-28 10:00\n   ```\n2. next";
  assert.equal(findBlocks(ok)[0].closed, true);
});

test("indentation rules: 4-space indented code isn't a fence; a 4-space indented ``` doesn't close", () => {
  assert.equal(findBlocks("para\n\n    ```timebox\n    start: 2026-09-28 10:00\n    ```").length, 0);
  const b = findBlocks("```timebox\nstart: 2026-09-28 10:00\n    ```\nnote: x\n```");
  assert.equal(b[0].closeLine, 4);
  assert.deepEqual(b[0].session.extra, ["    ```", "note: x"]);
  // nested list with deeper indentation is still a fence
  assert.equal(findBlocks("- a\n  - b\n    ```timebox\n    start: 2026-09-28 10:00\n    ```").length, 1);
});

test("same start twice: the running block is finished, the finished one is left alone", () => {
  const text =
    "```timebox\nstart: 2026-09-28 10:00\nend: 2026-09-28 10:30\n```\n\n```timebox\nstart: 2026-09-28 10:00\n```";
  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 12))!);
  assert.ok(out.startsWith("```timebox\nstart: 2026-09-28 10:00\nend: 2026-09-28 10:30\n```"), out);
  assert.ok(out.endsWith("start: 2026-09-28 10:00:00\nend: 2026-09-28 12:00:00\nduration: 2h\n```"), out);
});

test("finishing an already finished block (end typed by hand) changes nothing", () => {
  const text = "```timebox\nstart: 2026-09-28 10:00\nend: 10:25\n```";
  const edit = planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 21, 40))!;
  assert.equal(edit.unchanged, true);
  assert.equal(applyEdit(text, edit), text);
});

test("DST: a bare end on the next day keeps its wall-clock time", () => {
  // Find DST changes in the current time zone (none in UTC; CI runs this in several zones).
  for (let t = d(2026, 1, 1).getTime(); t < d(2027, 1, 1).getTime(); t += 30 * MIN) {
    if (new Date(t).getTimezoneOffset() === new Date(t + 30 * MIN).getTimezoneOffset()) continue;
    const change = new Date(t + 30 * MIN);
    const eve = new Date(change.getFullYear(), change.getMonth(), change.getDate() - 1, 23, 0);
    const s = ok(`start: ${formatStamp(eve)}\nend: 05:00`);
    assert.equal(formatStamp(s.end!).slice(11), "05:00:00", `end became ${formatStamp(s.end!)}`);
    assert.equal(dayDiff(s.start, s.end!), 1);
  }
});

test("mixed line endings: blocks are found and untouched lines keep their own endings", () => {
  const text = "a\r\nb\n```timebox\nstart: 2026-09-28 10:00\n```\r\nc\r\n";
  assert.equal(findBlocks(text).length, 1);
  const out = applyEdit(text, planFinish(text, d(2026, 9, 28, 10), d(2026, 9, 28, 10, 30))!);
  assert.equal(out, "a\r\nb\n```timebox\nstart: 2026-09-28 10:00:00\nend: 2026-09-28 10:30:00\nduration: 30m\n```\r\nc\r\n");
});

test("years below 1000 round-trip", () => {
  assert.equal(formatStamp(parseStamp("0050-01-01 10:00")!), "0050-01-01 10:00:00");
  assert.equal(formatStamp(parseStamp(formatStamp(parseStamp("0500-06-15 10:00")!))!), "0500-06-15 10:00:00");
});

test("pomodoro: non-finite elapsed time is treated as 0", () => {
  for (const x of [NaN, Infinity, -Infinity]) {
    const p = pomodoroPhase(x, cfg);
    assert.equal(p.kind, "work");
    assert.equal(p.index, 0);
    assert.equal(p.elapsedInPhase, 0);
  }
});

const BLOCK = "```timebox\ntopic: T\nstart: 2026-09-28 10:00:00\n```";
const insert = (text: string, line: number) => {
  const p = planInsert(text, line, BLOCK);
  const lines = text.split("\n");
  const off = (pos: { line: number; ch: number }) =>
    lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
  const out = text.slice(0, off(p.from)) + p.text + text.slice(off(p.to));
  return { out, plan: p };
};

test("planInsert: empty line is replaced, non-empty line gets the block below, cursor under it", () => {
  let r = insert("a\n\nb", 1);
  assert.equal(r.out, "a\n" + BLOCK + "\n\nb");
  assert.deepEqual(r.plan.cursor, { line: 5, ch: 0 });
  r = insert("a\n\nb", 0);
  assert.equal(r.out, "a\n" + BLOCK + "\n\nb", "an existing empty line below is reused");
  assert.deepEqual(r.plan.cursor, { line: 5, ch: 0 });
  r = insert("a\nb", 1);
  assert.equal(r.out, "a\nb\n" + BLOCK + "\n");
  assert.equal(findBlocks(r.out).length, 1);
});

test("planInsert: inside a callout the block keeps the quote prefix", () => {
  const r = insert("> [!note]\n> line\n> more", 1);
  assert.equal(r.out, "> [!note]\n> line\n> ```timebox\n> topic: T\n> start: 2026-09-28 10:00:00\n> ```\n> \n> more");
  assert.deepEqual(r.plan.cursor, { line: 6, ch: 2 });
  assert.equal(findBlocks(r.out).length, 1);
  const r2 = insert("> [!note]\n> ", 1);
  assert.equal(r2.out, "> [!note]\n> ```timebox\n> topic: T\n> start: 2026-09-28 10:00:00\n> ```\n> ");
  assert.equal(findBlocks(r2.out).length, 1);
});

test("planInsert: inside another code block the block goes below it", () => {
  const r = insert("```js\nlet a = 1\n\nlet b = 2\n```\nafter", 2);
  assert.equal(r.out, "```js\nlet a = 1\n\nlet b = 2\n```\n" + BLOCK + "\n\nafter");
  assert.equal(findBlocks(r.out).length, 1);
  // an unclosed code block runs to the end, so the block goes above it
  const r2 = insert("intro\n```js\nlet a = 1", 2);
  assert.equal(r2.out, "intro\n" + BLOCK + "\n\n```js\nlet a = 1");
  assert.equal(findBlocks(r2.out).length, 1);
  assert.deepEqual(r2.plan.cursor, { line: 5, ch: 0 });
});

// ─────────────── regressions from review round 2 ───────────────

test("planInsert: inside a code block closed implicitly by its quote, the block goes outside it", () => {
  const text = "> ```js\n> code\ntext";
  const out = applyInsert(text, planInsert(text, 1, BLOCK));
  assert.equal(out, "> ```js\n> code\n" + BLOCK + "\n\ntext");
  assert.equal(findBlocks(out).length, 1);
  // nested quote closed by a depth-1 line: the block stays in the outer quote
  const t2 = ">> ```js\n>> code\n> outer";
  const o2 = applyInsert(t2, planInsert(t2, 1, BLOCK));
  assert.equal(findBlocks(o2).length, 1, o2);
  assert.ok(o2.startsWith(">> ```js\n>> code\n> ```timebox\n"), o2);
  // a list item's code block closed by an unindented line
  const t3 = "- item\n  ```js\n  code\nnext";
  const o3 = applyInsert(t3, planInsert(t3, 2, BLOCK));
  assert.equal(findBlocks(o3).length, 1, o3);
  assert.ok(o3.endsWith("\nnext"));
});

test("planInsert: on a list item line the block is indented into the item", () => {
  const text = "- one\n- two";
  const out = applyInsert(text, planInsert(text, 0, BLOCK));
  assert.equal(out, "- one\n  ```timebox\n  topic: T\n  start: 2026-09-28 10:00:00\n  ```\n\n- two");
  assert.equal(findBlocks(out).length, 1);
  const t2 = "> 1. step";
  const o2 = applyInsert(t2, planInsert(t2, 0, BLOCK));
  assert.ok(o2.startsWith("> 1. step\n>    ```timebox\n"), o2);
  assert.equal(findBlocks(o2).length, 1);
});

test("applyInsert on CRLF text keeps every line ending CRLF", () => {
  const text = "a\r\nb\r\nc";
  const out = applyInsert(text, planInsert(text, 1, BLOCK));
  assert.equal(out, "a\r\nb\r\n" + BLOCK.replace(/\n/g, "\r\n") + "\r\n\r\nc");
  assert.equal(findBlocks(out).length, 1);
  const t2 = "abc\r\n\r\ndef";
  assert.equal(applyInsert(t2, planInsert(t2, 1, BLOCK)), "abc\r\n" + BLOCK.replace(/\n/g, "\r\n") + "\r\n\r\ndef");
});

test("list marker followed by a tab is measured from the marker's column", () => {
  assert.equal(findBlocks("-\titem\n\t```timebox\n\tstart: 2026-09-28 10:00\n\t```").length, 1);
  assert.equal(findBlocks("- item\n\t```timebox\n\tstart: 2026-09-28 10:00\n\t```").length, 1);
});

test("a fence far below its list item (long item) is still found", () => {
  const text = "- item\n" + "  para\n".repeat(250) + "    ```timebox\n    start: 2026-09-28 10:00\n    ```";
  assert.equal(findBlocks(text).length, 1);
});

// ─────────────── regressions from review round 3 ───────────────

test("isUnclosedAtEnd: valid blocks in a callout or list at the end of the note are not flagged", () => {
  const callout = "# N\n> [!note]\n> ```timebox\n> start: 2026-09-28 10:00\n> ```\n> some text";
  assert.equal(isUnclosedAtEnd(callout, 1, 5, "start: 2026-09-28 10:00"), false);
  const list = "- a\n  ```timebox\n  start: 2026-09-28 10:00\n  ```\n- b";
  assert.equal(isUnclosedAtEnd(list, 0, 4, "start: 2026-09-28 10:00"), false);
  const closedAtEnd = "x\n```timebox\nstart: 2026-09-28 10:00\n```\n";
  assert.equal(isUnclosedAtEnd(closedAtEnd, 1, 3, "start: 2026-09-28 10:00"), false);
});

test("isUnclosedAtEnd: fences never closed before the end of the note are flagged", () => {
  const open = "intro\n```timebox\nstart: 2026-09-28 10:00\n";
  assert.equal(isUnclosedAtEnd(open, 1, 3, "start: 2026-09-28 10:00\n"), true);
  assert.equal(isUnclosedAtEnd(open, 1, 2, "start: 2026-09-28 10:00\n"), true, "section size doesn't matter");
  const tilde = "```timebox\nstart: 2026-09-28 10:00\n~~~";
  assert.equal(isUnclosedAtEnd(tilde, 0, 2, "start: 2026-09-28 10:00\n~~~"), true, "~~~ doesn't close ```");
  const quoted = "> ```timebox\n> start: 2026-09-28 10:00";
  assert.equal(isUnclosedAtEnd(quoted, 0, 1, "start: 2026-09-28 10:00"), true);
  // two blocks in one callout: the right one is picked by its start
  const two = "> ```timebox\n> start: 2026-09-28 09:00\n> ```\n> ```timebox\n> start: 2026-09-28 10:00";
  assert.equal(isUnclosedAtEnd(two, 0, 4, "start: 2026-09-28 09:00"), false);
  assert.equal(isUnclosedAtEnd(two, 0, 4, "start: 2026-09-28 10:00"), true);
});

test("planInsert: a code block closed by a shallower list item gets the item's indentation", () => {
  const text = "- a\n  - b\n    ```js\n    code\n  - c";
  const out = applyInsert(text, planInsert(text, 3, BLOCK));
  assert.ok(out.startsWith("- a\n  - b\n    ```js\n    code\n  ```timebox\n"), out);
  assert.ok(out.endsWith("\n  - c"));
  assert.equal(findBlocks(out).length, 1);
});

test("planInsert: an indented blank line inside a list item stays in the item", () => {
  const text = "- a\n  \n  more";
  const out = applyInsert(text, planInsert(text, 1, BLOCK));
  assert.equal(out, "- a\n  ```timebox\n  topic: T\n  start: 2026-09-28 10:00:00\n  ```\n\n  more");
  assert.equal(findBlocks(out).length, 1);
  // a truly empty line after a list stays top-level
  const t2 = "- a\n\nb";
  assert.ok(applyInsert(t2, planInsert(t2, 1, BLOCK)).startsWith("- a\n```timebox\n"));
});

// ─────────────── regressions from review round 4 ───────────────

test("isUnclosedAtEnd: a block whose start doesn't match anything in the section isn't flagged", () => {
  assert.equal(isUnclosedAtEnd("![[Other]]\n```timebox\nstart: 2026-09-28 08:00", 0, 2, "start: 2026-09-28 10:00"), false);
  assert.equal(isUnclosedAtEnd("```timebox\nstart: 2026-09-28 08:00", 0, 1, "not a block"), false);
});

test("performance: rendering every block of a 2000-block note checks unclosed fences quickly", () => {
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const t = new Date(2026, 0, 1, 0, 0, i);
    parts.push("```timebox", `start: ${formatStamp(t)}`, "```", "");
  }
  const text = parts.join("\n");
  const ms = timed(() => {
    for (let i = 0; i < 2000; i++) {
      isUnclosedAtEnd(text, i * 4, i * 4 + 2, `start: ${formatStamp(new Date(2026, 0, 1, 0, 0, i))}`);
    }
  });
  assert.ok(ms < 1000, `took ${ms}ms`);
});

test("performance: thousands of distinct indentation widths", () => {
  const lines: string[] = [];
  for (let i = 0; i < 10_000; i++) lines.push(" ".repeat(1 + (i % 1000)) + "x", " ".repeat(5 + (i % 1000)) + "```");
  const ms = timed(() => findBlocks(lines.join("\n")));
  assert.ok(ms < 1000, `took ${ms}ms`);
});

// ─────────────── robustness ───────────────

/** Runs fn and returns the elapsed milliseconds. */
function timed(fn: () => void): number {
  const t = Date.now();
  fn();
  return Date.now() - t;
}

test("performance: pathological lines don't freeze parsing (no ReDoS)", () => {
  const huge = 200_000;
  const cases = [
    " ".repeat(huge) + "x",
    "\t".repeat(huge) + "x",
    "> ".repeat(huge / 2) + "x",
    ">".repeat(huge) + "x",
    " >".repeat(huge / 2) + "``x",
    "`".repeat(huge),
    "~".repeat(huge),
    "```timebox " + "`".repeat(huge),
    "start: " + "9".repeat(huge),
    "topic" + ":".repeat(huge),
  ];
  for (const line of cases) {
    const text = `${line}\n\`\`\`timebox\nstart: 2026-09-28 10:00\n\`\`\`\n${line}`;
    const ms = timed(() => {
      findBlocks(text);
      parseBlock(line);
      parseStamp(line);
    });
    assert.ok(ms < 500, `took ${ms}ms on a ${line.slice(0, 12)}… line`);
  }
});

test("performance: a large note with many blocks", () => {
  const parts: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const h = String(Math.floor(i / 60) % 24).padStart(2, "0");
    const m = String(i % 60).padStart(2, "0");
    parts.push(`## Section ${i}`, "Some text", "```js", "console.log(1)", "```");
    parts.push("```timebox", `topic: T${i}`, `start: 2026-09-28 ${h}:${m}:${String(i % 60).padStart(2, "0")}`, "```");
  }
  const text = parts.join("\n");
  let found = 0;
  const ms = timed(() => {
    found = findBlocks(text).length;
    planFinish(text, d(2026, 9, 28, 23, 59, 59), d(2026, 9, 29));
  });
  assert.equal(found, 2000);
  assert.ok(ms < 1000, `took ${ms}ms`);
});

test("performance: many indented fences and long list items (list lookback)", () => {
  const parts: string[] = [];
  for (let i = 0; i < 5000; i++) parts.push("    ```x", "    code", "    ```");
  const listy: string[] = [];
  for (let i = 0; i < 2000; i++) listy.push("- item " + i, ..."  continued\n".repeat(20).trim().split("\n"), "    ```timebox", "    start: 2026-09-28 10:00", "    ```");
  const ms = timed(() => {
    findBlocks(parts.join("\n"));
    findBlocks(listy.join("\n"));
    planInsert(listy.join("\n"), 10_000, BLOCK);
  });
  assert.ok(ms < 1000, `took ${ms}ms`);
});

test("performance: list lookups stay linear (50k indented fences under list-less text)", () => {
  const text = "  x\n    ```\n".repeat(50_000);
  const ms = timed(() => findBlocks(text));
  assert.ok(ms < 1000, `took ${ms}ms`);
});

/** Small deterministic PRNG so fuzz failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// ─────────────── pauses ───────────────

const at = (h: number, m: number, sec = 0) => d(2026, 9, 28, h, m, sec);

test("compact form: a paused total plus at most one open pause line", () => {
  const s = ok("topic: Math\nstart: 2026-09-28 10:00:00\npaused: 12m 30s\npause: 2026-09-28 11:00:00");
  assert.equal(s.pausedMs, 12.5 * MIN);
  assert.equal(formatStamp(openPause(s)!), "2026-09-28 11:00:00");
  // 10:00–11:00 minus 12.5 min worked, frozen while paused
  assert.equal(workedMs(s, at(13, 0).getTime()), 47.5 * MIN);
  assert.equal(pausedMs(s, at(11, 10).getTime()), 22.5 * MIN);
  const running = ok("start: 2026-09-28 10:00\npaused: 5m");
  assert.equal(openPause(running), null);
  assert.equal(workedMs(running, at(10, 30).getTime()), 25 * MIN);
});

test("parseBreak / formatBreak round-trip with second precision", () => {
  assert.equal(parseBreak("12m 30s"), 12.5 * MIN);
  assert.equal(parseBreak("1h 5m"), 65 * MIN);
  assert.equal(parseBreak("2H"), 120 * MIN);
  assert.equal(parseBreak("45s"), 45_000);
  assert.equal(parseBreak("< 1m"), 0);
  assert.equal(parseBreak("soon"), null);
  assert.equal(parseBreak(""), null);
  assert.equal(parseBreak("5"), null);
  for (const ms of [1000, 59_000, 60_000, 61_000, 3_600_000, 3_723_000, 100 * 3_600_000 + 1000]) {
    assert.equal(parseBreak(formatBreak(ms)), ms);
  }
  assert.equal(formatBreak(3_723_999), "1h 2m 3s");
  assert.equal(formatBreak(0), "0s");
});

test("old pause/resume pairs are still read and summed; their paused summary isn't added twice", () => {
  // as written by early 1.1.0 builds (the user's block)
  const s = ok(
    "topic: SA\nstart: 2026-11-17 12:09:24\npause: 2026-11-17 12:09:26\nresume: 2026-11-17 12:09:29\n" +
      "pause: 2026-11-17 12:09:30\nresume: 2026-11-17 12:09:31\nend: 2026-11-17 12:09:32\nduration: < 1m\npaused: < 1m"
  );
  assert.equal(s.pausedMs, 4000);
  assert.equal(workedMs(s, 0), 4000);
  // hand-typed pairs across midnight, ending paused
  const t = ok("start: 2026-09-28 23:50\npause: 23:55\nresume: 00:10\npause: 00:20");
  assert.equal(t.pausedMs, 15 * MIN);
  assert.equal(formatStamp(t.pausedAt!), "2026-09-29 00:20:00");
  // keys are case-insensitive, like the others
  assert.equal(ok("start: 2026-09-28 10:00\nPAUSE: 10:10\nResume: 10:15").pausedMs, 5 * MIN);
});

test("rewriting folds any number of breaks into two lines at most", () => {
  const lines = ["topic: T", "start: 2026-09-28 10:00:00"];
  for (let i = 0; i < 100; i++) {
    const m = 1 + i * 2;
    lines.push(`pause: 2026-09-28 ${String(10 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`);
    lines.push(`resume: 2026-09-28 ${String(10 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:30`);
  }
  lines.push("note: stays");
  const s = ok(lines.join("\n"));
  assert.equal(s.pausedMs, 100 * 30_000);
  assert.deepEqual(rewriteBody(lines, pauseAt(s, at(14, 0))), [
    "topic: T",
    "start: 2026-09-28 10:00:00",
    "paused: 50m",
    "pause: 2026-09-28 14:00:00",
    "note: stays",
  ]);
});

test("broken pause lines give clear errors", () => {
  const err = (src: string) => {
    const r = parseBlock(src);
    assert.ok(!r.ok, "expected an error for: " + src);
    return r.ok ? "" : r.error;
  };
  assert.match(err("start: 2026-09-28 10:00\nresume: 10:10"), /needs a “pause:” line/);
  assert.match(err("start: 2026-09-28 10:00\npause: 10:10\npause: 10:20"), /Two “pause:” lines/);
  assert.match(err("start: 2026-09-28 10:00\npause: soon"), /Can't read the pause time/);
  assert.match(err("start: 2026-09-28 10:00\npause:"), /Can't read the pause time/);
  assert.match(err("start: 2026-09-28 10:00\npause: 2026-09-28 09:00"), /before the line above/);
  assert.match(err("start: 2026-09-28 10:00\npaused: a while"), /Can't read the paused time/);
  assert.match(err("start: 2026-09-28 10:00\npause: 10:10\nend: 2026-09-28 10:05"), /last pause or resume/);
  assert.match(err("start: 2026-09-28 10:00\nend: 2026-09-28 09:00"), /before the start time/);
});

test("a hand-typed end while paused: the break runs until the end", () => {
  const s = ok("start: 2026-09-28 10:00\npaused: 5m\npause: 10:30\nend: 11:00");
  assert.equal(openPause(s), null);
  assert.equal(pausedMs(s, 0), 35 * MIN);
  assert.equal(workedMs(s, 0), 25 * MIN);
});

test("pauseAt / resumeAt: only running sessions pause, only paused ones resume", () => {
  const running = ok("start: 2026-09-28 10:00");
  const paused = pauseAt(running, at(10, 20));
  assert.equal(formatStamp(openPause(paused)!), "2026-09-28 10:20:00");
  assert.equal(pauseAt(paused, at(10, 25)), paused, "already paused: same object");
  assert.equal(resumeAt(running, at(10, 25)), running, "not paused: same object");
  const resumed = resumeAt(paused, at(10, 25));
  assert.equal(openPause(resumed), null);
  assert.equal(resumed.pausedMs, 5 * MIN);
  assert.equal(workedMs(resumed, at(10, 40).getTime()), 35 * MIN);
  const again = resumeAt(pauseAt(resumed, at(10, 50)), at(10, 51, 30));
  assert.equal(again.pausedMs, 6.5 * MIN);
  const done = ok("start: 2026-09-28 10:00\nend: 11:00");
  assert.equal(pauseAt(done, at(10, 20)), done, "finished: same object");
  // a clock that went backwards never produces times out of order
  assert.equal(formatStamp(openPause(pauseAt(running, at(9, 0)))!), "2026-09-28 10:00:00");
  assert.equal(resumeAt(paused, at(10, 0)).pausedMs, 0);
});

test("finishAt: a paused session ends where the break began; the total never exceeds the session", () => {
  const s = ok("start: 2026-09-28 10:00\npaused: 12m\npause: 11:00");
  const a = finishAt(s, at(14, 0));
  assert.equal(formatStamp(a.end!), "2026-09-28 11:00:00");
  assert.equal(a.pausedAt, null);
  assert.equal(workedMs(a, 0), 48 * MIN);
  // "I actually stopped at 10:50": before the open break → it is dropped
  const b = finishAt(s, at(10, 50));
  assert.equal(formatStamp(b.end!), "2026-09-28 10:50:00");
  assert.equal(workedMs(b, 0), 38 * MIN);
  // "10:05": the total is capped at the session's length
  const c = finishAt(s, at(10, 5));
  assert.equal(c.pausedMs, 5 * MIN);
  assert.equal(workedMs(c, 0), 0);
  // never before the start
  assert.equal(formatStamp(finishAt(s, at(9, 0)).end!), "2026-09-28 10:00:00");
});

test("addBreak: clipped to the session; reaching the open break moves it back", () => {
  const running = ok("start: 2026-09-28 10:00\npaused: 10m");
  assert.equal(addBreak(running, at(11, 0), at(11, 15)).pausedMs, 25 * MIN);
  assert.equal(addBreak(running, at(9, 0), at(10, 5)).pausedMs, 15 * MIN, "clipped to the start");
  const paused = pauseAt(running, at(11, 30));
  const e = addBreak(paused, at(11, 20), at(11, 45));
  assert.equal(formatStamp(openPause(e)!), "2026-09-28 11:20:00");
  assert.equal(e.pausedMs, 10 * MIN);
  assert.equal(addBreak(paused, at(11, 35), at(11, 40)), paused, "inside the open break: nothing to add");
  // empty or inverted ranges change nothing
  assert.equal(addBreak(running, at(11, 0), at(11, 0)), running);
  assert.equal(addBreak(running, at(9, 0), at(9, 30)), running);
  // a finished session: clipped to the end
  assert.equal(addBreak(ok("start: 2026-09-28 10:00\nend: 11:00"), at(10, 50), at(12, 0)).pausedMs, 10 * MIN);
});

test("writing: paused sits below duration; the open pause goes last", () => {
  const s = finishAt(resumeAt(ok("topic: Math\nstart: 2026-09-28 10:00:00\nmode: pomodoro\npaused: 12m\npause: 11:00\nnote: p. 42"), at(11, 10)), at(12, 0));
  assert.equal(
    serializeBlock(s),
    ["topic: Math", "start: 2026-09-28 10:00:00", "mode: pomodoro", "end: 2026-09-28 12:00:00", "duration: 1h 38m", "paused: 22m", "note: p. 42"].join("\n")
  );
  assert.equal(
    serializeBlock(pauseAt(ok("start: 2026-09-28 10:00\npaused: 30s"), at(10, 20))),
    "start: 2026-09-28 10:00:00\npaused: 30s\npause: 2026-09-28 10:20:00"
  );
  // sessions without breaks get no "paused:" line
  assert.ok(!serializeBlock(ok("start: 2026-09-28 10:00\nend: 11:00")).includes("paused"));
});

test("rewriteBody: notes stay in place around the break lines", () => {
  const body = ["topic: T", "note: one", "start: 2026-09-28 10:00", "pause: 10:10", "note: two", "resume: 10:20", "", "paused: 99h"];
  assert.deepEqual(rewriteBody(body, pauseAt(ok(body.join("\n")), at(10, 30))), [
    "topic: T",
    "note: one",
    "start: 2026-09-28 10:00:00",
    "paused: 10m",
    "pause: 2026-09-28 10:30:00",
    "note: two",
    "",
  ]);
  // finishing while paused removes the open pause and writes net duration
  assert.deepEqual(rewriteBody(["start: 2026-09-28 10:00", "pause: 10:05"], finishAt(ok("start: 2026-09-28 10:00\npause: 10:05"), at(12, 0))), [
    "start: 2026-09-28 10:00:00",
    "end: 2026-09-28 10:05:00",
    "duration: 5m",
  ]);
});

test("planChange: pausing and resuming many times keeps the block short", () => {
  let text = "a\n```timebox\ntopic: T\nstart: 2026-09-28 10:00:00\n```\nb";
  const start = at(10, 0);
  for (let i = 0; i < 50; i++) {
    text = applyEdit(text, planChange(text, start, (s) => pauseAt(s, at(10, i, 10)))!);
    assert.ok(planChange(text, start, (s) => pauseAt(s, at(10, i, 20)))!.unchanged);
    text = applyEdit(text, planChange(text, start, (s) => resumeAt(s, at(10, i, 40)))!);
  }
  assert.equal(text, "a\n```timebox\ntopic: T\nstart: 2026-09-28 10:00:00\npaused: 25m\n```\nb");
  const done = applyEdit(text, planFinish(text, start, at(11, 0))!);
  assert.ok(done.includes("duration: 35m\npaused: 25m\n```"));
  assert.ok(planChange(done, start, (s) => pauseAt(s, at(11, 5)))!.unchanged);
  assert.equal(planChange(text, at(9, 0), (s) => s), null);
});

test("pomodoro phase follows worked time, so it stands still during a break", () => {
  const s = ok("start: 2026-09-28 10:00\nmode: pomodoro\npaused: 30m");
  const p = (h: number, m: number) => pomodoroPhase(workedMs(s, at(h, m).getTime()), cfg);
  assert.equal(p(10, 50).elapsedInPhase, 20 * MIN);
  assert.equal(p(10, 54).kind, "work");
  assert.equal(p(10, 56).kind, "short");
  const frozen = ok("start: 2026-09-28 10:00\nmode: pomodoro\npause: 10:20");
  assert.equal(pomodoroPhase(workedMs(frozen, at(10, 45).getTime()), cfg).elapsedInPhase, 20 * MIN);
});

test("lastOccurrence: today if the time has passed, otherwise yesterday", () => {
  const now = d(2026, 9, 28, 14, 30, 20);
  assert.equal(formatStamp(lastOccurrence(14, 10, now)!), "2026-09-28 14:10:00");
  assert.equal(formatStamp(lastOccurrence(14, 30, now)!), "2026-09-28 14:30:00");
  assert.equal(formatStamp(lastOccurrence(23, 50, now)!), "2026-09-27 23:50:00");
  assert.equal(formatStamp(lastOccurrence(23, 50, d(2026, 1, 1, 0, 5))!), "2025-12-31 23:50:00");
  assert.equal(lastOccurrence(24, 0, now), null);
  assert.equal(lastOccurrence(1.5, 0, now), null);
  assert.equal(lastOccurrence(-1, 0, now), null);
});

// ─────────────── fuzz ───────────────

test("fuzz: random notes never throw, and edits only touch the block body", () => {
  const pieces = [
    "```timebox", "~~~timebox", "````timebox", "> ```timebox", "  ```timebox", "```", "~~~", "````", "> ```",
    "```python", "````markdown", "topic: X", "TOPIC: y", "start: 2026-09-28 10:00", "start: 10:00",
    "start: 28.09.2026 09:30:15", "end: 11:00", "end: 2026-09-28 09:00", "duration: 1h", "mode: pomodoro",
    "note: hi", "", ">", "> start: 2026-09-28 12:00", "plain text", "start:", "end:", ":", "`inline`",
    "\u00a0start: 10:00", "start: 25:99", "- list item", "\r",
    "pause: 10:20", "resume: 10:30", "pause: 2026-09-28 10:40:00", "resume: 09:00", "pause:", "paused: 5m", "Resume: 10:50",
    "paused: 1h 2m 3s", "paused: soon", "paused: < 1m", "PAUSED: 45s",
  ];
  const next = rng(42);
  for (let iter = 0; iter < 3000; iter++) {
    const n = 1 + Math.floor(next() * 25);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(pieces[Math.floor(next() * pieces.length)]);
    const text = lines.join("\n");

    for (const src of [text, lines.slice(1).join("\n")]) {
      const r = parseBlock(src, d(2026, 9, 28));
      if (r.ok) {
        assert.ok(!isNaN(r.session.start.getTime()));
        if (r.session.end) assert.ok(r.session.end >= r.session.start);
        // an open pause is never before the start, and a finished session has none
        assert.ok(r.session.pausedMs >= 0);
        if (r.session.pausedAt) assert.ok(r.session.pausedAt >= r.session.start && !r.session.end);
        const far = r.session.start.getTime() + 1000 * MIN;
        assert.ok(workedMs(r.session, far) >= 0 && pausedMs(r.session, far) >= 0);
      } else {
        assert.ok(r.error.length > 0);
      }
    }

    for (const b of findBlocks(text, d(2026, 9, 28))) {
      assert.ok(b.openLine < b.closeLine);
      const target = findBlockByStart(text, b.session.start, d(2026, 9, 28))!;
      assert.ok(target, "a found block must be findable by its start");
      const end = new Date(b.session.start.getTime() + 90 * MIN);
      const edit = planFinish(text, b.session.start, end, d(2026, 9, 28));
      assert.ok(edit, "a found block must be editable");
      const out = applyEdit(text, edit!);
      if (target.session.end) {
        // already finished (e.g. an end typed by hand): left exactly as it was
        assert.ok(edit!.unchanged);
        assert.equal(out, text);
        continue;
      }
      const before = text.split("\n");
      const after = out.split("\n");
      const delta = edit!.lines.length - (edit!.toLine - edit!.fromLine);
      // everything before and after the body is unchanged
      assert.deepEqual(after.slice(0, edit!.fromLine), before.slice(0, edit!.fromLine));
      assert.deepEqual(after.slice(edit!.toLine + delta), before.slice(edit!.toLine));
      // the finished block reads back with the same start and the new end
      const again = findBlocks(out, d(2026, 9, 28)).find((x) => x.openLine === target.openLine);
      assert.ok(again, "block must still be found after the edit");
      assert.equal(formatStamp(again!.session.start), formatStamp(b.session.start));
      // the end is the requested one, or where the break it fell into began
      const wanted = finishAt(target.session, end);
      assert.equal(formatStamp(again!.session.end!), formatStamp(wanted.end!));
      assert.equal(workedMs(again!.session, 0), workedMs(wanted, 0));
      // pausing, resuming and adding a break only touch the body too, and read back
      const changes = [
        (s: Session) => pauseAt(s, end),
        (s: Session) => resumeAt(s, end),
        (s: Session) => addBreak(s, new Date(end.getTime() - 20 * MIN), end),
      ];
      for (const change of changes) {
        const e2 = planChange(text, b.session.start, change, d(2026, 9, 28))!;
        const out2 = applyEdit(text, e2);
        if (e2.unchanged) {
          assert.equal(out2, text);
          continue;
        }
        const after2 = out2.split("\n");
        const delta2 = e2.lines.length - (e2.toLine - e2.fromLine);
        assert.deepEqual(after2.slice(0, e2.fromLine), before.slice(0, e2.fromLine));
        assert.deepEqual(after2.slice(e2.toLine + delta2), before.slice(e2.toLine));
        const again2 = findBlocks(out2, d(2026, 9, 28)).find((x) => x.openLine === target.openLine);
        assert.ok(again2, "block must still be found after a pause edit");
        assert.equal(serializeBlock(again2!.session), serializeBlock(change(target.session)));
      }
      // finishing again changes nothing
      assert.equal(applyEdit(out, planFinish(out, b.session.start, end, d(2026, 9, 28))!), out);
    }
  }
});

// ─────────────── runner ───────────────

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}`);
    console.log(String(e instanceof Error ? e.stack ?? e.message : e).replace(/^/gm, "      "));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
if (failed > 0) process.exit(1);
