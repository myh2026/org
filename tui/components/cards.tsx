// ============================================================================
// org/tui/components/cards.tsx — 八类事件卡片渲染（规格书 §3）
// ----------------------------------------------------------------------------
// 每张卡 = Line[]（纯函数，宽度 → 行数确定），线程视口按行精确滚动。
// 徽标统一风格：[A 内联] 方括号 + 单字母 + 短词；裁决四态徽标同构。
// ============================================================================

import type { Theme } from "../theme.ts";
import type { Card, FactorySteps, Subtask } from "../store.ts";
import { routeLabel } from "../store.ts";
import { displayWidth, fitLine, truncate, wrapWithPrefix, type Line } from "../text.ts";

const ROLE_W = 3; // "you" / "org"

function badge(text: string, color: string): Span2 {
  return { t: `[${text}]`, c: color, b: true };
}
type Span2 = { t: string; c?: string; b?: boolean; dim?: boolean };

const dim = (t: string): Span2 => ({ t, c: undefined, dim: true });

function rolePrefix(role: string, color: string | undefined): Span2 {
  return { t: role.padEnd(ROLE_W) + " ", c: color, b: true };
}

function stepIcon(s: keyof FactorySteps, steps: FactorySteps): Span2 {
  const v = steps[s];
  const labels: Record<keyof FactorySteps, string> = {
    spec: "规格", mint: "生成", check: "check", accept: "验收", register: "登记 git",
  };
  const label = labels[s];
  if (v === "done") return { t: `✓${label}`, c: "ok" };
  if (v === "active") return { t: `▸${label}`, c: "brand", b: true };
  return dim(label);
}

/**
 * 卡片 → 行序列（不含卡间空行）。颜色值是语义 token 名（ok/warn/...），
 * 由 thread.tsx 渲染时经主题查表 —— 保持本函数与主题解耦、可独立断言。
 */
export function renderCard(card: Card, width: number): Line[] {
  const W = Math.max(20, width);
  const lines: Line[] = [];
  const fit = (l: Line): void => { lines.push(fitLine(l, W)); };
  const body = (prefix: Span2[], text: string, color?: string, indent = 0): void => {
    for (const l of wrapWithPrefix(prefix, text, color, W, indent)) lines.push(fitLine(l, W));
  };

  switch (card.t) {
    case "user": {
      body([rolePrefix("you", "brand")], card.text, "fg");
      break;
    }
    case "task": {
      fit([rolePrefix("org", "ok"), { t: `任务分解 → ${card.subtasks.length} 子任务`, b: true }]);
      if (card.mission) body([dim("   ")], card.mission, undefined, 3);
      for (const qa of card.qa) {
        body([dim("   ? ")], qa.q, undefined, 5);
        if (qa.a) body([dim("   → ")], qa.a, undefined, 5);
      }
      card.subtasks.forEach((s, i) => {
        const branch = i === card.subtasks.length - 1 ? "└" : "├";
        const stateMark = s.state === "done" ? { t: " ✓", c: "ok" } : s.state === "running" ? { t: " …", c: "brand" } : { t: "", c: undefined };
        const prefix: Span2[] = [
          { t: `   ${branch} `, dim: true },
          { t: `task#${s.id}`, c: "fg" },
          { t: ` ${s.role}`, c: "fg", b: true },
          { t: "  " },
          badge(`${s.route} ${routeLabel(s.route)}`, routeColor(s.route)),
        ];
        const rest: Span2[] = [];
        if (s.expert) rest.push({ t: ` ${s.expert}`, c: "info" });
        rest.push(stateMark);
        const l = [...prefix, ...rest];
        lines.push(fitLine(l, W));
      });
      break;
    }
    case "factory": {
      const title = card.name ? `${card.name}@${card.version ?? "?"}` : "现场铸造";
      const tone = card.failed ? "err" : "fg";
      fit([{ t: "⚙ ", c: card.failed ? "err" : "warn" }, { t: "工厂 ", c: tone }, { t: title, c: tone, b: true }]);
      const steps = card.steps;
      const order: Array<keyof FactorySteps> = ["spec", "mint", "check", "accept", "register"];
      const row: Line = [{ t: "   " }];
      order.forEach((s, i) => {
        if (i > 0) row.push({ t: " → ", dim: true });
        row.push(stepIcon(s, steps));
      });
      fit(row);
      if (card.failed) {
        for (const l of card.failed.split("\n").slice(0, 3)) {
          body([{ t: "   " }], l, "err", 3);
        }
      }
      break;
    }
    case "review": {
      const vc = verdictColor(card.verdict);
      const cov = card.coverage !== undefined ? ` · 覆盖率 ${card.coverage.toFixed(2)}` : "";
      const attempt = card.attempt > 1 ? `（第${card.attempt - 1}次返工后）` : "";
      fit([
        { t: "◆ ", c: vc },
        { t: "review ", c: "dim" },
        { t: `${card.task} ${card.role}`, c: "fg", b: true },
        { t: "  " },
        badge(card.verdict, vc),
        { t: cov, c: "fg" },
        dim(attempt),
      ]);
      if (card.remedy) body([{ t: "   remedy ", dim: true }], card.remedy, "warn", 10);
      break;
    }
    case "crystal": {
      const zero = card.hits.length > 0;
      fit([
        { t: zero ? "⚡ " : "❄ ", c: zero ? "brand" : "info" },
        { t: "固化 ", c: "fg", b: true },
        { t: `冻结 ${card.frozen.length}`, c: "fg" },
        { t: " · " , dim: true },
        { t: `命中 ${card.hits.length}`, c: "fg" },
        { t: zero ? "  零模型调用" : "", c: "brand", b: true },
      ]);
      const tail: string[] = [
        ...card.frozen.slice(-2).map((f) => `❄ ${f.node} ← "${truncate(f.input, 24)}"`),
        ...card.hits.slice(-2).map((h) => `⚡ ${h.node} ← "${truncate(h.input, 24)}"`),
      ].slice(-3);
      for (const t of tail) fit([{ t: "   ", dim: true }, dim(t)]);
      break;
    }
    case "patch": {
      fit([{ t: "⇡ ", c: "info" }, { t: "补丁 ", c: "fg", b: true }, dim(truncate(card.trigger, W - 10))]);
      const bits: Span2[] = [{ t: "   " }];
      if (card.version) bits.push({ t: `v1.0.0 → v${card.version}`, c: "info" });
      if (card.sha) bits.push({ t: ` · git ${card.sha}`, dim: true });
      if (card.confirmed) bits.push({ t: " · 金丝雀确认（蓝绿生效）", c: "ok" });
      if (bits.length > 1) fit(bits);
      break;
    }
    case "direct": {
      const status = card.done ? "" : " …";
      fit([
        { t: "⚡ ", c: "info" },
        { t: "直连 ", c: "fg", b: true },
        { t: card.expert ?? "?", c: "info", b: true },
        dim(status),
      ]);
      body([{ t: "   q ", dim: true }], card.question, "fg", 5);
      for (const a of card.answers.slice(-2)) {
        body([{ t: "   a ", c: "ok" }], a, "fg", 5);
      }
      // 上下文窗口占用（Codex 风格计量条；direct_ctx 事件驱动）
      if (card.ctxTokens !== undefined) {
        const w = card.ctxWindow ?? 131072;
        const pct = w > 0 ? Math.min(1, card.ctxTokens / w) : 0;
        const cells = 12;
        const filled = Math.max(card.ctxTokens > 0 ? 1 : 0, Math.min(cells, Math.round(pct * cells)));
        const bar = "▓".repeat(filled) + "░".repeat(cells - filled);
        const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
        fit([
          { t: "   ctx ", dim: true },
          { t: bar, c: "info" },
          { t: ` ${fmtK(card.ctxTokens)}/${fmtK(w)}（${(pct * 100).toFixed(1)}%）`, dim: true },
          { t: card.ctxTurn !== undefined ? ` · ${card.ctxTurn} 轮` : "", dim: true },
        ]);
      }
      if (card.turns !== undefined && card.turns > 0) {
        fit([{ t: `   ${card.turns} 轮 · 已记账 · 纪要已回写会话账本`, dim: true }]);
      }
      break;
    }
    case "done": {
      if (card.ok) {
        const bits: Span2[] = [
          { t: "✓ ", c: "ok" },
          { t: "汇总 ", c: "ok", b: true },
          { t: `交付物 ${card.deliverables ?? "?"}`, c: "fg" },
          { t: " · ", dim: true },
          { t: `资产 ${card.assets ?? "?"}`, c: "fg" },
          { t: " · ", dim: true },
          { t: `model_calls ${card.modelCalls ?? "?"}`, c: "brand", b: true },
          { t: ` · revises ${card.revises ?? 0}`, c: "fg" },
          { t: ` · ${((card.elapsedMs ?? 0) / 1000).toFixed(1)}s`, dim: true },
        ];
        fit(bits);
        if (card.decay) fit([{ t: "   成本衰减 model_calls ", dim: true }, { t: card.decay, c: "brand", b: true }]);
        for (const label of (card.assetLabels ?? []).slice(0, 3)) {
          fit([{ t: "   · ", dim: true }, dim(truncate(label, W - 8))]);
        }
        if (card.sha) fit([{ t: `   git ${card.sha}`, dim: true }]);
      } else {
        fit([{ t: "✗ ", c: "err" }, { t: "汇总 ", c: "err", b: true }, { t: "运行失败", c: "err" }]);
        if (card.error) body([{ t: "   " }], card.error, "err", 3);
      }
      break;
    }
    case "system": {
      const color = card.tone === "err" ? "err" : card.tone === "warn" ? "warn" : card.tone === "ok" ? "ok" : undefined;
      const mark = card.tone === "err" ? "✗ " : card.tone === "warn" ? "⚠ " : card.tone === "ok" ? "✓ " : "· ";
      body([{ t: mark, c: color, dim: color === undefined }], card.text, color, 2);
      break;
    }
    case "score": {
      fit([
        { t: "▦ ", c: "info" },
        { t: "评分卡 ", c: "fg", b: true },
        { t: `model=${card.model} · evidence=${card.evidence}`, dim: true },
      ]);
      for (const cell of card.cells) {
        const pad = " ".repeat(Math.max(1, 34 - displayWidth(cell.cell)));
        fit([
          { t: "   ", dim: true },
          { t: cell.cell, c: "fg" },
          { t: pad, dim: true },
          { t: `score=${cell.score.toFixed(3)}`, c: cell.score >= 0.9 ? "ok" : cell.score >= 0.5 ? "warn" : "err" },
          { t: `  confidence(n)=${cell.confidence}`, dim: true },
        ]);
      }
      break;
    }
  }
  return lines;
}

export function routeColor(r: Subtask["route"]): string {
  return r === "A" ? "badgeA" : r === "B" ? "badgeB" : r === "C" ? "badgeC" : "badgeD";
}

export function verdictColor(v: string): string {
  switch (v.toLowerCase()) {
    case "accept": return "verdictAccept";
    case "revise": return "verdictRevise";
    case "reject": return "verdictReject";
    case "escalate": return "verdictEscalate";
    default: return "verdictAccept";
  }
}

/** 语义 token 名 → 主题色值（渲染时查表）。 */
export function resolveColor(name: string | undefined, theme: Theme): string | undefined {
  if (!name) return undefined;
  const t = theme as unknown as Record<string, string>;
  return t[name] ?? name;
}
