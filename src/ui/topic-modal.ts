import { App, Modal, Setting } from "obsidian";
import type { SessionMode } from "../core";

/**
 * Asks for the session topic. `ask()` resolves with the entered text, or null if cancelled.
 * An empty string means "use the note name"; the caller handles that.
 */
export class TopicModal extends Modal {
  private resolve: ((v: string | null) => void) | null = null;
  private result: string | null = null;
  private inputEl!: HTMLInputElement;

  constructor(app: App, private initial: string, private noteName: string, private mode: SessionMode) {
    super(app);
  }

  ask(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.mode === "pomodoro" ? "Start pomodoro session" : "Start session");

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "timebox-modal-input",
      attr: { placeholder: this.noteName, "aria-label": "Topic", spellcheck: "false" },
    });
    this.inputEl.value = this.initial;
    this.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        this.submit();
      }
    });

    contentEl.createDiv({
      cls: "timebox-modal-hint",
      text: "What are you working on? Leave empty to use the note name.",
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Start")
          .setCta()
          .onClick(() => this.submit())
      );

    this.inputEl.focus();
    this.inputEl.select();
  }

  private submit(): void {
    this.result = this.inputEl.value.replace(/\s+/g, " ").trim();
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.result);
    this.resolve = null;
  }
}
