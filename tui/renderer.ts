// ============================================================================
// org/tui/renderer.ts — 零依赖 ANSI 渲染器（全平台：Windows Terminal / iTerm2 /
// ----------------------------------------------------------------------------
// Linux 终端）。设计：
//   - 帧组合是纯函数（frame.ts），本文件只做 Line → ANSI 串与屏幕生命周期。
//   - 单次 write 写整帧（home + 逐行 clear）——无闪烁的关键。
//   - 真彩色 24bit，降级链：NO_COLOR / 非 TTY → 纯文本。
//   - 备用屏缓冲 + 隐藏光标；退出时完整恢复。
// ============================================================================

import type { Line, Span } from "./text.ts";
import type { Theme } from "./theme.ts";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const RESET = "\x1b[0m";

function spanToAnsi(s: Span, theme: Theme, colorEnabled: boolean): string {
  let out = "";
  if (colorEnabled) {
    const token = s.c;
    const color = token ? (theme as unknown as Record<string, string>)[token] ?? token : undefined;
    if (color) {
      const rgb = hexToRgb(color);
      if (rgb) out += `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
      else if (/^[a-z]+$/i.test(color)) out += `\x1b[${color}m`;
    }
    if (s.b) out += "\x1b[1m";
    if (s.dim) out += "\x1b[2m";
    if (s.inverse) out += "\x1b[7m";
  }
  out += s.t;
  if (colorEnabled && (s.c || s.b || s.dim || s.inverse)) out += RESET;
  return out;
}

export function lineToAnsi(line: Line, theme: Theme, colorEnabled: boolean): string {
  if (line.length === 0) return "";
  let out = "";
  for (const s of line) out += spanToAnsi(s, theme, colorEnabled);
  return out;
}

/** 一帧 = 行数组。Screen 负责把行数组写成 ANSI。 */
export class Screen {
  private lastFrame: string[] = [];
  private entered = false;

  constructor(
    private stdout: NodeJS.WriteStream,
    private theme: Theme,
  ) {}

  get colorEnabled(): boolean {
    return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  }

  enter(): void {
    if (!process.stdout.isTTY) return;
    this.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    this.entered = true;
  }

  exit(): void {
    if (!this.entered) return;
    this.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    this.entered = false;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.lastFrame = [];
  }

  /** 整帧重绘：只有内容变化才 write（省带宽、防闪烁）。 */
  draw(lines: Line[]): void {
    const color = this.colorEnabled;
    const rendered = lines.map((l) => lineToAnsi(l, this.theme, color));
    if (rendered.length === this.lastFrame.length && rendered.every((l, i) => l === this.lastFrame[i])) {
      return;
    }
    // 单次 write：home → 逐行（clear-to-EOL + 内容），行间 CR LF。
    let buf = "";
    if (this.entered) buf += "\x1b[H";
    for (let i = 0; i < rendered.length; i++) {
      if (i > 0) buf += "\x1b[K\r\n";
      else if (this.entered) buf += "\x1b[K";
      buf += rendered[i]!;
    }
    if (this.entered && rendered.length < this.lastFrame.length) {
      // 帧行数变少：清掉残留行
      for (let i = rendered.length; i < this.lastFrame.length; i++) buf += "\x1b[K\r\n";
    }
    this.stdout.write(buf);
    this.lastFrame = rendered;
  }

  /** 非 TTY 场景（--print / 冒烟）：无 ANSI 的纯文本帧。 */
  static toPlainText(lines: Line[]): string {
    return lines.map((l) => l.map((s) => s.t).join("")).join("\n");
  }
}
