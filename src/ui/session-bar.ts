import { MarkdownRenderChild, setIcon } from "obsidian";
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
  formatTimer,
  pomodoroPhase,
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

    const ms = end.getTime() - s.start.getTime();
    row.createSpan({ cls: "timebox-elapsed", text: formatDuration(ms) });

    if (s.mode === "pomodoro") {
      const n = completedPomodoros(ms, pomodoroConfig(this.plugin.settings));
      const text =
        n === 0
          ? "🍅 No pomodoros completed"
          : `${"🍅".repeat(Math.min(n, MAX_TOMATOES))}${n > MAX_TOMATOES ? "…" : ""} ${n} ${n === 1 ? "pomodoro" : "pomodoros"}`;
      this.barEl?.createDiv({ cls: "timebox-meta", text });
    }
  }

  // ───────────── active session ─────────────

  private renderActive(s: Session): void {
    const row = this.renderRow(s, "timer");
    this.barEl?.addClass("is-active");

    const times = row.createSpan({ cls: "timebox-times" });
    times.appendText(`${formatClock(s.start)} → `);
    times.createSpan({ cls: "timebox-running", text: "in progress" });

    this.elapsedEl = row.createSpan({ cls: "timebox-elapsed", attr: { "aria-live": "off" } });

    const btn = row.createEl("button", { cls: "timebox-btn", attr: { "aria-label": "Finish session" } });
    setIcon(btn.createSpan({ cls: "timebox-btn-icon" }), "square");
    btn.createSpan({ text: "Finish" });
    // In Live Preview, keep the click from moving the cursor into the block
    btn.addEventListener("mousedown", (evt) => evt.preventDefault());
    btn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      void this.finish(btn, s);
    });

    if (s.mode === "pomodoro") {
      const pomo = this.barEl?.createDiv({ cls: "timebox-pomo" });
      if (pomo) {
        this.pomoLabelEl = pomo.createDiv({ cls: "timebox-pomo-label" });
        const track = pomo.createDiv({ cls: "timebox-progress" });
        this.pomoFillEl = track.createDiv({ cls: "timebox-fill" });
      }
    }
  }

  private async finish(btn: HTMLButtonElement, s: Session): Promise<void> {
    btn.disabled = true;
    btn.addClass("is-busy");
    const ok = await this.plugin.stopSession({ path: this.sourcePath, start: formatStamp(s.start) });
    // On success the file changes and Obsidian re-renders the block; otherwise re-enable the button.
    if (!ok) {
      btn.disabled = false;
      btn.removeClass("is-busy");
    }
  }

  private update(): void {
    if (!this.result.ok) return;
    const s = this.result.session;
    const elapsed = Date.now() - s.start.getTime();
    this.elapsedEl?.setText(formatTimer(elapsed));

    if (s.mode !== "pomodoro" || !this.pomoLabelEl || !this.pomoFillEl) return;
    const p = pomodoroPhase(elapsed, pomodoroConfig(this.plugin.settings));
    const left = formatTimer(p.phaseLength - p.elapsedInPhase);
    const label =
      p.kind === "work"
        ? `${PHASE_EMOJI.work} Pomodoro ${p.pomodoro} · ${PHASE_LABEL.work} · ${left} left`
        : `${PHASE_EMOJI[p.kind]} ${PHASE_LABEL[p.kind]} · ${left} left`;
    this.pomoLabelEl.setText(label);
    const ratio = Math.min(1, Math.max(0, p.elapsedInPhase / p.phaseLength));
    this.pomoFillEl.style.setProperty("--timebox-progress", `${(ratio * 100).toFixed(2)}%`);
    this.barEl?.toggleClass("is-break", p.kind !== "work");
  }
}
