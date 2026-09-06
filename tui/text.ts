// ============================================================================
// org/tui/text.ts — 终端文本度量与折行（零依赖，Windows 兼容）
// ----------------------------------------------------------------------------
// 线程视口按「行」精确滚动：每张卡的渲染行数必须是纯函数（width → 行数），
// 因此这里实现显示宽度（CJK=2）度量、截断、贪心折行。
// ============================================================================

export interface Span {
  t: string;
  c?: string;      // 颜色 token 值（hex 或 ANSI 名）
  b?: boolean;     // bold
  dim?: boolean;
  inverse?: boolean;
}

export type Line = Span[];

/** 单字符显示宽度：East Asian Wide/Fullwidth = 2，其余 1。 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK 部首补充 · 康熙部首 · CJK 符号
    (cp >= 0x3041 && cp <= 0x33ff) ||   // 平假名 · 片假名 · 注音 · CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) ||   // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK 扩展 B+
  ) return 2;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||   // 组合附加符号
    (cp >= 0x200b && cp <= 0x200f)      // 零宽字符
  ) return 0;
  return 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 按显示宽度截断，超出部分以 … 结尾。 */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** 按显示宽度贪心折行（CJK 可断行，ASCII 词优先按空格）。 */
export function wrapText(s: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const para of s.split("\n")) {
    if (displayWidth(para) <= width) {
      out.push(para);
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const token of para.split(/(\s+)/)) {
      if (token.length === 0) continue;
      const tw = displayWidth(token);
      if (curW + tw <= width) {
        cur += token;
        curW += tw;
        continue;
      }
      if (tw > width) {
        // 超宽 token（长 URL / 长中文段）：逐字断
        for (const ch of token) {
          const cw = charWidth(ch);
          if (curW + cw > width) {
            out.push(cur);
            cur = "";
            curW = 0;
          }
          cur += ch;
          curW += cw;
        }
        continue;
      }
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
        curW = 0;
      }
      // 纯空白 token 在行首直接丢弃
      if (token.trim().length === 0) continue;
      cur = token;
      curW = tw;
    }
    out.push(cur);
  }
  return out;
}

/** 单行 Span 适配宽度：整体按显示宽度截断（末尾 …）。 */
export function fitLine(line: Line, width: number): Line {
  const total = line.reduce((acc, s) => acc + displayWidth(s.t), 0);
  if (total <= width) return line;
  const out: Line = [];
  let rest = width;
  for (let i = 0; i < line.length; i++) {
    const s = line[i]!;
    const w = displayWidth(s.t);
    if (w <= rest) {
      out.push(s);
      rest -= w;
    } else {
      if (rest > 0) out.push({ ...s, t: truncate(s.t, rest) });
      break;
    }
  }
  return out;
}

/** 多段文本（前缀 + 正文）续行折行：首行带 prefix，续行带 continuationIndent 缩进。 */
export function wrapWithPrefix(
  prefix: Line,
  body: string,
  bodyColor: string | undefined,
  width: number,
  continuationIndent: number,
): Line[] {
  const prefixW = prefix.reduce((acc, s) => acc + displayWidth(s.t), 0);
  const firstW = Math.max(1, width - prefixW);
  const restW = Math.max(1, width - continuationIndent);
  const out: Line[] = [];
  const push = (text: string, isFirst: boolean): void => {
    if (isFirst) out.push([...prefix, { t: text, c: bodyColor }]);
    else out.push([{ t: " ".repeat(continuationIndent) }, { t: text, c: bodyColor }]);
  };
  const tokens = body.match(/\S+\s*|\s+/g) ?? [];
  let line = "";
  let budget = firstW;
  let isFirst = true;
  for (const token of tokens) {
    let tw = displayWidth(token);
    if (tw > budget) {
      // 换行（行首空白丢弃）
      const trimmedLine = line.trimEnd();
      push(trimmedLine, isFirst);
      isFirst = false;
      line = "";
      budget = restW;
      if (tw > restW) {
        // 超宽 token：逐字断
        for (const ch of token) {
          const cw = charWidth(ch);
          if (cw > budget) {
            push(line, isFirst);
            isFirst = false;
            line = "";
            budget = restW;
          }
          line += ch;
          budget -= cw;
        }
        continue;
      }
      const t = token.trimStart();
      tw = displayWidth(t);
      if (tw === 0) continue;
      line = t;
      budget -= tw;
      continue;
    }
    line += token;
    budget -= tw;
  }
  push(line.trimEnd(), isFirst);
  return out;
}
