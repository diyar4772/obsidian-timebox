import { Notice } from "obsidian";
import { notificationsSupported } from "../settings";

/** Phase-change alerts: a Notice, a WebAudio beep and (if permitted) a system notification. */
export class Alerts {
  private audio: AudioContext | null = null;

  notify(title: string, body: string, opts: { sound: boolean; system: boolean; breakTone: boolean }): void {
    const message = createFragment((f) => {
      f.createEl("strong", { text: title });
      f.createEl("br");
      f.appendText(body);
    });
    new Notice(message, 10_000);
    if (opts.sound) this.beep(opts.breakTone);
    if (opts.system) this.systemNotification(title, body);
  }

  /** Two short beeps: lower-pitched when a break starts, higher when focus starts. */
  beep(breakTone: boolean): void {
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.audio ??= new Ctor();
      const ctx = this.audio;
      if (ctx.state === "suspended") void ctx.resume();

      const freq = breakTone ? 660 : 880;
      const t0 = ctx.currentTime + 0.02;
      for (let i = 0; i < 2; i++) {
        const start = t0 + i * 0.22;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.18);
      }
    } catch (e) {
      console.warn("[timebox] could not play sound", e);
    }
  }

  private systemNotification(title: string, body: string): void {
    try {
      if (notificationsSupported() && Notification.permission === "granted") {
        new Notification(title, { body, silent: true });
      }
    } catch (e) {
      console.warn("[timebox] could not show system notification", e);
    }
  }

  dispose(): void {
    if (this.audio) void this.audio.close().catch(() => undefined);
    this.audio = null;
  }
}
