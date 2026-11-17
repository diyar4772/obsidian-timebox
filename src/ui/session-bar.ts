import { MarkdownRenderChild, Menu, setIcon } from "obsidian";
import {
  PHASE_EMOJI,
  PHASE_LABEL,
  ParseResult,
  Session,
  completedPomodoros,
  dayDiff,
  formatClock,
  formatDuration,
  formatStamp,
  formatBreak,
  formatTimer,
  openPause,
  pausedMs,
  pomodoroPhase,
  workedMs,
} from "../core";
import { pomodoroConfig } from "../settings";
import type TimeboxPlugin from "../main";

/** At most this many 🍅 are drawn for a finished session; the count is written as a number too. */
const MAX_TOMATOES = 8;

/**
 * The bar rendered in place of a `timebox` code block.
 * Active sessions update every second; the interval is cleared automatically
 * when the block is removed (when this MarkdownRenderChild unloads).
 */
export class SessionBar extends MarkdownRenderChild {
  private elapsedEl: HTMLElement | null = null;
  private pomoLabelEl: HTMLElement | null = null;
  private pomoFillEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private breaksEl: HTMLElement | null = null;

  constructor(
    containerEl: HTMLElement,
    private plugin: TimeboxPlugin,
    private result: ParseResult,
    private sourcePath: string
  ) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl.empty();
    if (!this.result.ok) {
      this.renderError(this.result.error);
      return;
    }
    const s = this.result.session;
    if (s.end) {
      this.renderDone(s, s.end);
    } else {
      this.renderActive(s);
      this.update();
      this.registerInterval(window.setInterval(() => this.update(), 1000));
    }
  }

  // ───────────── error ─────────────

  private renderError(message: string): void {
    const box = this.containerEl.createDiv({ cls: "timebox-error" });
    setIcon(box.createSpan({ cls: "timebox-error-icon" }), "alert-triangle");
    const text = box.createDiv();
    text.createDiv({ cls: "timebox-error-title", text: "Can't read this timebox block" });
    text.createDiv({ text: message });
  }

  // ───────────── shared skeleton ─────────────

  private renderRow(s: Session, icon: string): HTMLElement {
    this.barEl = this.containerEl.createDiv({ cls: "timebox-bar" });
    if (s.mode === "pomodoro") this.barEl.addClass("is-pomodoro");
    const row = this.barEl.createDiv({ cls: "timebox-row" });
    setIcon(row.createSpan({ cls: "timebox-icon" }), icon);
    const topic = s.topic || "Session";
    row.createSpan({ cls: "timebox-topic", text: topic, attr: { title: topic } });
    return row;
  }

  // ───────────── finished session ─────────────

  private renderDone(s: Session, end: Date): void {
    const row = this.renderRow(s, "check");
    this.barEl?.addClass("is-done");

    const times = row.createSpan({ cls: "timebox-times" });
    times.appendText(`${formatClock(s.start)} → ${formatClock(end)}`);
    const days = dayDiff(s.start, end);
    if (days > 0) {
      times.createSpan({
        cls: "timebox-dayshift",
        text: ` (+${days})`,
        attr: { title: `Ended: ${formatStamp(end)}` },
      });
    }

    // Net time: breaks are not counted.
    const ms = workedMs(s, end.getTime());
    row.createSpan({ cls: "timebox-elapsed", text: formatDuration(ms) });

    const meta: string[] = [];
    if (s.mode === "pomodoro") {
      const n = completedPomodoros(ms, pomodoroConfig(this.plugin.settings));
      meta.push(
        n === 0
          ? "🍅 No pomodoros completed"
          : `${"🍅".repeat(Math.min(n, MAX_TOMATOES))}${n > MAX_TOMATOES ? "…" : ""} ${n} ${n === 1 ? "pomodoro" : "pomodoros"}`
      );
    }
    if (pausedMs(s, end.getTime()) > 0) meta.push(this.breaksText(s, end.getTime()));
    if (meta.length > 0) this.barEl?.createDiv({ cls: "timebox-meta", text: meta.join(" · ") });
  }

  /** "Breaks: 12m 30s" */
  private breaksText(s: Session, now: number): string {
    return `Breaks: ${formatBreak(pausedMs(s, now))}`;
  }

  // ───────────── active session ─────────────

  private renderActive(s: Session): void {
    const paused = openPause(s) !== null;
    const row = this.renderRow(s, paused ? "pause" : "timer");
    this.barEl?.addClass(paused ? "is-paused" : "is-active");

    const times = row.createSpan({ cls: "timebox-times" });
    times.appendText(`${formatClock(s.start)} → `);
    times.createSpan({ cls: "timebox-running", text: paused ? "paused" : "in progress" });

    this.elapsedEl = row.createSpan({ cls: "timebox-elapsed", attr: { "aria-live": "off" } });

    // Blocks outside markdown notes (e.g. Canvas cards) can't be located in a file to change them.
    if (this.sourcePath.endsWith(".md")) this.renderActions(row, s, paused);

    if (s.mode === "pomodoro") {
      const pomo = this.barEl?.createDiv({ cls: "timebox-pomo" });
      if (pomo) {
        this.pomoLabelEl = pomo.createDiv({ cls: "timebox-pomo-label" });
        const track = pomo.createDiv({ cls: "timebox-progress" });
        this.pomoFillEl = track.createDiv({ cls: "timebox-fill" });
      }
    }
    if (s.pausedMs > 0 || paused) this.breaksEl = this.barEl?.createDiv({ cls: "timebox-meta" }) ?? null;
  }

  private renderActions(row: HTMLElement, s: Session, paused: boolean): void {
    const ref = { path: this.sourcePath, start: formatStamp(s.start) };
    const actions = row.createDiv({ cls: "timebox-actions" });

    this.button(actions, paused ? "play" : "pause", paused ? "Resume" : "Pause", paused ? "Resume session" : "Pause session", (btn) =>
      void this.run(btn, () => (paused ? this.plugin.resumeSession(ref) : this.plugin.pauseSession(ref)))
    );
    this.button(actions, "square", "Finish", "Finish session", (btn) => void this.run(btn, () => this.plugin.stopSession(ref)));
    this.button(actions, "more-horizontal", "", "More options", (_btn, evt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Finish at an earlier time…")
          .setIcon("history")
          .onClick(() => void this.plugin.promptFinishAt(ref))
      );
      menu.addItem((item) =>
        item
          .setTitle("Add a break…")
          .setIcon("coffee")
          .onClick(() => void this.plugin.promptBreak(ref))
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private button(
    parent: HTMLElement,
    icon: string,
    text: string,
    label: string,
    onClick: (btn: HTMLButtonElement, evt: MouseEvent) => void
  ): void {
    const btn = parent.createEl("button", { cls: "timebox-btn", attr: { "aria-label": label } });
    setIcon(btn.createSpan({ cls: "timebox-btn-icon" }), icon);
    if (text) btn.createSpan({ text });
    else btn.addClass("is-icon-only");
    // In Live Preview, keep the click from moving the cursor into the block
    btn.addEventListener("mousedown", (evt) => evt.preventDefault());
    btn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      onClick(btn, evt);
    });
  }

  /** Runs a block edit with the button disabled. */
  private async run(btn: HTMLButtonElement, action: () => Promise<boolean>): Promise<void> {
    btn.disabled = true;
    btn.addClass("is-busy");
    const ok = await action();
    // On success the file changes and Obsidian re-renders the block; otherwise re-enable the button.
    if (!ok) {
      btn.disabled = false;
      btn.removeClass("is-busy");
    }
  }

  private update(): void {
    if (!this.result.ok) return;
    const s = this.result.session;
    const now = Date.now();
    const open = openPause(s);
    // Worked time: stands still while the session is paused.
    const elapsed = workedMs(s, now);
    this.elapsedEl?.setText(formatTimer(elapsed));
    if (this.breaksEl) {
      const breaks = this.breaksText(s, now);
      this.breaksEl.setText(open ? `Paused for ${formatTimer(now - open.getTime())} · ${breaks}` : breaks);
    }

    if (s.mode !== "pomodoro" || !this.pomoLabelEl || !this.pomoFillEl) return;
    const p = pomodoroPhase(elapsed, pomodoroConfig(this.plugin.settings));
    const left = formatTimer(p.phaseLength - p.elapsedInPhase);
    const label =
      p.kind === "work"
        ? `${PHASE_EMOJI.work} Pomodoro ${p.pomodoro} · ${PHASE_LABEL.work} · ${left} left`
        : `${PHASE_EMOJI[p.kind]} ${PHASE_LABEL[p.kind]} · ${left} left`;
    this.pomoLabelEl.setText(open ? `${label} · paused` : label);
    const ratio = Math.min(1, Math.max(0, p.elapsedInPhase / p.phaseLength));
    this.pomoFillEl.style.setProperty("--timebox-progress", `${(ratio * 100).toFixed(2)}%`);
    this.barEl?.toggleClass("is-break", p.kind !== "work");
  }
}
