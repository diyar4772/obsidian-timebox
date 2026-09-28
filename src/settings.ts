import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { PomodoroConfig, SessionMode } from "./core";
import type TimeboxPlugin from "./main";

export interface TimeboxSettings {
  /** Mode used by the "Start session" command and the ribbon icon. */
  defaultMode: SessionMode;
  /** Whether starting a new session closes open sessions at the current time. */
  autoStopPrevious: boolean;
  /** Pomodoro durations (minutes). */
  work: number;
  short: number;
  long: number;
  /** A long break after every N focus periods. */
  longEvery: number;
  sound: boolean;
  systemNotification: boolean;
  statusBar: boolean;
}

export const DEFAULT_SETTINGS: TimeboxSettings = {
  defaultMode: "simple",
  autoStopPrevious: true,
  work: 25,
  short: 5,
  long: 15,
  longEvery: 4,
  sound: true,
  systemNotification: false,
  statusBar: true,
};

const MAX_MINUTES = 600;

export function pomodoroConfig(s: TimeboxSettings): PomodoroConfig {
  return { work: s.work, short: s.short, long: s.long, longEvery: s.longEvery };
}

/** Validates settings loaded from data.json; broken or missing fields fall back to defaults. */
export function sanitizeSettings(raw: unknown): TimeboxSettings {
  const s: TimeboxSettings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  const r = raw as Record<string, unknown>;
  if (r.defaultMode === "simple" || r.defaultMode === "pomodoro") s.defaultMode = r.defaultMode;
  for (const k of ["autoStopPrevious", "sound", "systemNotification", "statusBar"] as const) {
    const v = r[k];
    if (typeof v === "boolean") s[k] = v;
  }
  for (const k of ["work", "short", "long", "longEvery"] as const) {
    const v = r[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_MINUTES) s[k] = v;
  }
  return s;
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export class TimeboxSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TimeboxPlugin) {
    super(app, plugin);
  }

  // ───────────── Obsidian 1.13+: declarative settings (also indexed by the settings search) ─────────────
  // Obsidian calls getSettingDefinitions() and skips display(); older versions only call display().
  // Keep both in sync when adding or changing a setting.

  getSettingDefinitions(): SettingDefinitionItem[] {
    const minutes = (value: number) =>
      Number.isInteger(value) && value >= 1 && value <= MAX_MINUTES ? undefined : `Enter a whole number from 1 to ${MAX_MINUTES}.`;
    const number = (key: "work" | "short" | "long" | "longEvery") => ({
      type: "number" as const,
      key,
      min: 1,
      max: MAX_MINUTES,
      step: 1,
      defaultValue: DEFAULT_SETTINGS[key],
      validate: minutes,
    });
    return [
      {
        name: "Default mode",
        desc: "Mode used when you start a session from the command palette or the ribbon icon.",
        control: {
          type: "dropdown",
          key: "defaultMode",
          defaultValue: DEFAULT_SETTINGS.defaultMode,
          options: { simple: "Simple (time only)", pomodoro: "Pomodoro" },
        },
      },
      {
        name: "Finish previous session on start",
        desc: "When you start a new session, any open session is finished at the current time.",
        control: { type: "toggle", key: "autoStopPrevious" },
      },
      {
        type: "group",
        heading: "Pomodoro",
        items: [
          {
            name: "How phases work",
            desc:
              "The phase is calculated from the time elapsed since the session started. If you change these " +
              "durations, the phases of running pomodoro sessions are recalculated with the new values.",
            searchable: false,
          },
          { name: "Focus duration", desc: "Length of one pomodoro, in minutes.", control: number("work") },
          { name: "Short break", desc: "Length of a short break, in minutes.", control: number("short") },
          { name: "Long break", desc: "Length of a long break, in minutes.", control: number("long") },
          {
            name: "Long break interval",
            desc: "Take a long break instead of a short one after this many pomodoros.",
            control: number("longEvery"),
          },
        ],
      },
      {
        type: "group",
        heading: "Alerts",
        items: [
          {
            name: "Sound",
            desc: "Play a short beep when the pomodoro phase changes.",
            control: { type: "toggle", key: "sound" },
          },
          {
            name: "System notification",
            desc: notificationsSupported()
              ? "Also show an operating system notification when the phase changes (asks for permission)."
              : "System notifications aren't supported on this device.",
            control: { type: "toggle", key: "systemNotification", disabled: !notificationsSupported() },
          },
        ],
      },
      {
        type: "group",
        heading: "Appearance",
        items: [
          {
            name: "Status bar",
            desc: "Show the active session in the status bar. Click it to open the session's note.",
            control: { type: "toggle", key: "statusBar" },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /** Saves through the plugin so data.json keeps its active-session list (the default would save only the settings). */
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "systemNotification" && value === true && notificationsSupported() && Notification.permission !== "granted") {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        new Notice("Permission for system notifications was not granted.");
        // Show the toggle as off again. update() exists on 1.13+, the only version that calls this method.
        (this as { update?: () => void }).update?.();
        return;
      }
    }
    this.plugin.settings = sanitizeSettings({ ...this.plugin.settings, [key]: value });
    await this.plugin.saveSettings();
  }

  // ───────────── Obsidian < 1.13: imperative settings ─────────────

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default mode")
      .setDesc("Mode used when you start a session from the command palette or the ribbon icon.")
      .addDropdown((d) =>
        d
          .addOption("simple", "Simple (time only)")
          .addOption("pomodoro", "Pomodoro")
          .setValue(s.defaultMode)
          .onChange(async (v) => {
            s.defaultMode = v === "pomodoro" ? "pomodoro" : "simple";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Finish previous session on start")
      .setDesc("When you start a new session, any open session is finished at the current time.")
      .addToggle((t) =>
        t.setValue(s.autoStopPrevious).onChange(async (v) => {
          s.autoStopPrevious = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Pomodoro").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "The phase is calculated from the time elapsed since the session started. If you change these " +
        "durations, the phases of running pomodoro sessions are recalculated with the new values.",
    });
    this.numberSetting("Focus duration", "Length of one pomodoro, in minutes.", "work");
    this.numberSetting("Short break", "Length of a short break, in minutes.", "short");
    this.numberSetting("Long break", "Length of a long break, in minutes.", "long");
    this.numberSetting("Long break interval", "Take a long break instead of a short one after this many pomodoros.", "longEvery");

    new Setting(containerEl).setName("Alerts").setHeading();

    new Setting(containerEl)
      .setName("Sound")
      .setDesc("Play a short beep when the pomodoro phase changes.")
      .addToggle((t) =>
        t.setValue(s.sound).onChange(async (v) => {
          s.sound = v;
          await this.plugin.saveSettings();
        })
      );

    const notif = new Setting(containerEl)
      .setName("System notification")
      .setDesc("Also show an operating system notification when the phase changes (asks for permission).");
    if (!notificationsSupported()) {
      notif.setDesc("System notifications aren't supported on this device.").setDisabled(true);
    }
    notif.addToggle((t) =>
      t
        .setValue(s.systemNotification)
        .setDisabled(!notificationsSupported())
        .onChange(async (v) => {
          if (v && notificationsSupported() && Notification.permission !== "granted") {
            const result = await Notification.requestPermission();
            if (result !== "granted") {
              new Notice("Permission for system notifications was not granted.");
              t.setValue(false);
              return;
            }
          }
          s.systemNotification = v;
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Status bar")
      .setDesc("Show the active session in the status bar. Click it to open the session's note.")
      .addToggle((t) =>
        t.setValue(s.statusBar).onChange(async (v) => {
          s.statusBar = v;
          await this.plugin.saveSettings();
        })
      );
  }

  private numberSetting(name: string, desc: string, key: "work" | "short" | "long" | "longEvery"): void {
    const s = this.plugin.settings;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = String(MAX_MINUTES);
        text.inputEl.addClass("timebox-number-input");
        text
          .setPlaceholder(String(DEFAULT_SETTINGS[key]))
          .setValue(String(s[key]))
          .onChange(async (v) => {
            const n = Number(v);
            const valid = v.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES;
            text.inputEl.toggleClass("timebox-invalid", !valid);
            if (!valid) return;
            s[key] = n;
            await this.plugin.saveSettings();
          });
      });
  }
}
