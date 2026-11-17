import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import { formatClock, formatDuration, lastOccurrence } from "../core";

/** A modal that resolves with a value when it closes (null if cancelled). */
abstract class AskModal<T> extends Modal {
  private resolve: ((v: T | null) => void) | null = null;
  protected result: T | null = null;

  ask(): Promise<T | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  protected finish(value: T): void {
    this.result = value;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.result);
    this.resolve = null;
  }

  /** A row of small buttons that fill in a value. */
  protected quickRow(labels: [string, () => void][]): void {
    const row = this.contentEl.createDiv({ cls: "timebox-modal-quick" });
    for (const [text, onClick] of labels) {
      row.createEl("button", { text }).addEventListener("click", (evt) => {
        evt.preventDefault();
        onClick();
      });
    }
  }

  protected submitOnEnter(input: HTMLInputElement, submit: () => void): void {
    input.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        submit();
      }
    });
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "I forgot to stop it": asks when the work really ended. Resolves with a time between the
 * session's start and now.
 */
export class FinishAtModal extends AskModal<Date> {
  private inputEl!: HTMLInputElement;
  private errorEl!: HTMLElement;

  constructor(app: App, private topic: string, private start: Date) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Finish at an earlier time");
    contentEl.createDiv({
      cls: "timebox-modal-hint",
      text: `When did you stop working on “${this.topic}”? It started at ${formatClock(this.start)}.`,
    });

    this.inputEl = contentEl.createEl("input", {
      type: "time",
      cls: "timebox-modal-input",
      attr: { "aria-label": "End time" },
    });
    this.setMinutesAgo(0);
    this.submitOnEnter(this.inputEl, () => this.submit());

    this.quickRow(
      ([5, 15, 30, 60] as const).map((m) => [m === 60 ? "1 h ago" : `${m} min ago`, () => this.setMinutesAgo(m)])
    );
    this.errorEl = contentEl.createDiv({ cls: "timebox-modal-error" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Finish")
          .setCta()
          .onClick(() => this.submit())
      );
    this.inputEl.focus();
  }

  private setMinutesAgo(minutes: number): void {
    const t = new Date(Math.max(Date.now() - minutes * 60_000, this.start.getTime()));
    this.inputEl.value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  private submit(): void {
    const m = this.inputEl.value.match(/^(\d{1,2}):(\d{2})/);
    const now = new Date();
    let at = m ? lastOccurrence(+m[1], +m[2], now) : null;
    if (!at) {
      this.errorEl.setText("Enter a time, for example 17:40.");
      return;
    }
    // The session's first minute: "18:29" for a session started at 18:29:40 means its start.
    if (at.getTime() < this.start.getTime() && this.start.getTime() - at.getTime() < 60_000) at = this.start;
    if (at.getTime() < this.start.getTime()) {
      this.errorEl.setText(`That's before the session started (${formatClock(this.start)}).`);
      return;
    }
    this.finish(at);
  }
}

/** "I was away": asks how many minutes to count as a break, ending now. Resolves with the minutes. */
export class BreakModal extends AskModal<number> {
  private inputEl!: HTMLInputElement;
  private errorEl!: HTMLElement;

  constructor(app: App, private topic: string) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Add a break");
    contentEl.createDiv({
      cls: "timebox-modal-hint",
      text: `How many minutes were you away from “${this.topic}”? The break ends now and isn't counted as work.`,
    });

    this.inputEl = contentEl.createEl("input", {
      type: "number",
      cls: "timebox-modal-input",
      attr: { min: "1", max: "1440", step: "1", "aria-label": "Minutes" },
    });
    this.inputEl.value = "10";
    this.submitOnEnter(this.inputEl, () => this.submit());

    this.quickRow(
      ([5, 10, 15, 30] as const).map((m) => [
        `${m} min`,
        () => {
          this.inputEl.value = String(m);
        },
      ])
    );
    this.errorEl = contentEl.createDiv({ cls: "timebox-modal-error" });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Add break")
          .setCta()
          .onClick(() => this.submit())
      );
    this.inputEl.focus();
    this.inputEl.select();
  }

  private submit(): void {
    const n = Number(this.inputEl.value);
    if (this.inputEl.value.trim() === "" || !Number.isFinite(n) || n <= 0 || n > 1440) {
      this.errorEl.setText("Enter a number of minutes from 1 to 1440.");
      return;
    }
    this.finish(n);
  }
}

export type AwayChoice = "break" | "keep";

/** Shown after the computer slept or Obsidian was closed while a session was running. */
export class AwayModal extends AskModal<AwayChoice> {
  constructor(app: App, private from: Date, private to: Date, private topics: string[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText("Were you away?");
    const what = this.topics.length === 1 ? `“${this.topics[0]}” was` : `${this.topics.length} sessions were`;
    const length = formatDuration(this.to.getTime() - this.from.getTime());
    contentEl.createDiv({
      text: `${what} running, but nothing happened here from ${formatClock(this.from)} to ${formatClock(this.to)} (${length}).`,
    });
    contentEl.createDiv({
      cls: "timebox-modal-hint",
      text: "Count that time as a break if you weren't working.",
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Keep the time").onClick(() => this.finish("keep")))
      .addButton((b) =>
        b
          .setButtonText("Count as a break")
          .setCta()
          .onClick(() => this.finish("break"))
      );
  }
}

/** Picks one of several running sessions. */
export class SessionSuggestModal<T extends { topic: string; path: string }> extends FuzzySuggestModal<T> {
  constructor(app: App, private items: T[], private onPick: (item: T) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return `${item.topic || "Session"} · ${item.path.replace(/\.md$/, "")}`;
  }

  onChooseItem(item: T): void {
    this.onPick(item);
  }
}
