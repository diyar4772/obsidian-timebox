// A minimal stand-in for the "obsidian" module, just enough to run src/main.ts in Node.
// esbuild aliases "obsidian" to this file when bundling test/plugin.test.ts.

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  stat = { ctime: new Date(2026, 8, 28, 8, 0).getTime(), mtime: 0, size: 0 };
  get basename(): string {
    return this.path.replace(/^.*\//, "").replace(/\.md$/, "");
  }
}

export class Notice {
  static log: string[] = [];
  constructor(message: unknown) {
    Notice.log.push(typeof message === "string" ? message : "[fragment]");
  }
}

export class Component {
  registerInterval(id: number): number {
    return id;
  }
  registerEvent(): void {}
  registerDomEvent(): void {}
}

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: unknown) {
    super();
  }
}

export class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}

export class PluginSettingTab {}
export class Setting {}
export function setIcon(): void {}

type Pos = { line: number; ch: number };

/** A text-backed editor. Like CodeMirror, it maps the cursor through edits. */
export class Editor {
  cursor: Pos = { line: 0, ch: 0 };
  selection = "";
  constructor(public text: string) {}
  getValue(): string {
    return this.text;
  }
  getLine(n: number): string {
    return this.text.split("\n")[n];
  }
  lastLine(): number {
    return this.text.split("\n").length - 1;
  }
  getSelection(): string {
    return this.selection;
  }
  getCursor(): Pos {
    return this.cursor;
  }
  setCursor(p: Pos): void {
    this.cursor = p;
  }
  private offset(p: Pos): number {
    const lines = this.text.split("\n");
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i].length + 1;
    return o + p.ch;
  }
  private pos(offset: number): Pos {
    const before = this.text.slice(0, offset).split("\n");
    return { line: before.length - 1, ch: before[before.length - 1].length };
  }
  replaceRange(insert: string, from: Pos, to?: Pos): void {
    const a = this.offset(from);
    const b = to ? this.offset(to) : a;
    let c = this.offset(this.cursor);
    if (c >= b) c += insert.length - (b - a);
    else if (c > a) c = a + insert.length;
    this.text = this.text.slice(0, a) + insert + this.text.slice(b);
    this.cursor = this.pos(c);
  }
}

export class MarkdownView {
  constructor(public file: TFile, public editor: Editor, public mode: "source" | "preview" = "source") {}
  getMode(): string {
    return this.mode;
  }
  getState(): Record<string, unknown> {
    return { mode: this.mode };
  }
  async setState(state: { mode: "source" | "preview" }): Promise<void> {
    this.mode = state.mode;
  }
}

export class Plugin {
  data: unknown = null;
  processors = new Map<string, (source: string, el: unknown, ctx: unknown) => void>();
  commands: { id: string; name: string; checkCallback?: (checking: boolean) => boolean }[] = [];
  vaultHandlers = new Map<string, (...args: unknown[]) => void>();
  constructor(public app: any) {}
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(d: unknown): Promise<void> {
    this.data = JSON.parse(JSON.stringify(d));
  }
  registerMarkdownCodeBlockProcessor(lang: string, fn: (source: string, el: unknown, ctx: unknown) => void): void {
    this.processors.set(lang, fn);
  }
  addCommand(c: { id: string; name: string; checkCallback?: (checking: boolean) => boolean }): void {
    this.commands.push(c);
  }
  addRibbonIcon(): void {}
  addStatusBarItem(): any {
    const el: any = {
      shown: true,
      text: "",
      addClass() {},
      toggle(v: boolean) {
        el.shown = v;
      },
      setText(t: string) {
        el.text = t;
      },
      setAttr() {},
    };
    return el;
  }
  registerInterval(): void {}
  registerEvent(): void {}
  registerDomEvent(): void {}
  addSettingTab(): void {}
}
