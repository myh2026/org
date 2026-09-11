// ============================================================================
// tests/gate.test.ts — ask 串行门（排队票据化）机制级测试（v0.4.14）
// ----------------------------------------------------------------------------
// 覆盖 web/gate.ts 的完整语义（与 HTTP 层解耦的确定性单元测试）：
//   1. FIFO 串行：enter 严格按入队顺序执行，一轮跑完下一轮才开跑
//   2. busy/current 状态转移：空闲 → 运行 → 空闲
//   3. cancel(排队轮) → "cancelled"：轮到时拒绝执行（QueueCancelledError），
//      fn 根本不被调用（不占流水线、不落账本）
//   4. cancel 不误伤：取消 B 不影响 A 与后续 C 的执行
//   5. cancel(运行轮) → "running"（端点据此走 SIGKILL 传统路径）
//   6. cancel(查无此票) → "unknown"
//   7. release：流终结清理；排队中的票据不摘（断开 ≠ 取消，轮次照常落账本）
//   8. fn 失败不堵队列：后续轮照常执行（链式吞错）
// ============================================================================

import { describe, test, expect } from "bun:test";
import { AskGate, QueueCancelledError } from "../web/gate.ts";

/** 手动受控的延迟任务（test 里替代真实 dhv 流水线，时序完全确定）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AskGate：ask 串行门（web/gate.ts · v0.4.14 排队票据）", () => {
  test("FIFO 串行：一轮跑完下一轮才开跑（顺序保证）", async () => {
    const gate = new AskGate();
    const order: string[] = [];
    const a = deferred<void>();
    const b = deferred<void>();

    const runA = gate.enter(async () => {
      order.push("A:start");
      await a.promise;
      order.push("A:end");
    }, gate.issue());
    const runB = gate.enter(async () => {
      order.push("B:start");
      await b.promise;
      order.push("B:end");
    }, gate.issue());

    await Bun.sleep(10); // 事件循环转一圈：A 开跑、B 仍排队
    expect(order).toEqual(["A:start"]);
    expect(gate.busy).toBe(true);
    expect(gate.queuedCount).toBe(1); // B 在队

    a.resolve();
    await runA;
    await Bun.sleep(10);
    expect(order).toEqual(["A:start", "A:end", "B:start"]);
    expect(gate.busy).toBe(true);

    b.resolve();
    await runB;
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
    expect(gate.busy).toBe(false);
    expect(gate.current).toBeNull();
  });

  test("cancel(排队轮) → 轮到时拒绝执行（fn 不被调用，QueueCancelledError）", async () => {
    const gate = new AskGate();
    let bRan = false;
    const a = deferred<void>();

    const runA = gate.enter(async () => {
      await a.promise;
    }, gate.issue());
    const tb = gate.issue();
    const runB = gate.enter(async () => {
      bRan = true;
    }, tb);

    // B 还在排队 → 取消
    expect(gate.cancel(tb.id)).toBe("cancelled");
    a.resolve();
    await runA;

    // B 的轮到时刻：拒绝执行（不跑 fn）
    let rejected: unknown = null;
    await runB.catch((e) => {
      rejected = e;
    });
    expect(rejected).toBeInstanceOf(QueueCancelledError);
    expect((rejected as Error).message).toBe("已取消排队：本轮未开始");
    expect(bRan).toBe(false);
    expect(gate.busy).toBe(false);
  });

  test("取消 B 不误伤 A 与后续 C（队列继续消化）", async () => {
    const gate = new AskGate();
    const order: string[] = [];
    const a = deferred<void>();
    const cStarted = deferred<void>();

    const runA = gate.enter(async () => {
      order.push("A");
      await a.promise;
    }, gate.issue());
    const tb = gate.issue();
    const runB = gate.enter(async () => {
      order.push("B");
    }, tb);
    const runC = gate.enter(async () => {
      order.push("C");
      cStarted.resolve();
    }, gate.issue());

    expect(gate.cancel(tb.id)).toBe("cancelled");
    a.resolve();
    await runA;
    await runC;
    await cStarted.promise;

    expect(order).toEqual(["A", "C"]); // B 被跳过，A/C 完好
    await runB.catch(() => undefined); // B 已拒绝（吞掉，验证链未断）
    expect(gate.busy).toBe(false);
  });

  test("cancel(运行轮) → \"running\"；cancel(查无) → \"unknown\"", async () => {
    const gate = new AskGate();
    const a = deferred<void>();
    const ta = gate.issue();
    const runA = gate.enter(async () => {
      await a.promise;
    }, ta);

    await Bun.sleep(10); // A 开跑
    expect(gate.cancel(ta.id)).toBe("running");
    expect(gate.cancel(99999)).toBe("unknown");

    a.resolve();
    await runA;
    // 结束后同一 id 再 cancel → 已摘票 → unknown
    expect(gate.cancel(ta.id)).toBe("unknown");
  });

  test("release：终态票据清理；排队中票据不摘（断开 ≠ 取消）", async () => {
    const gate = new AskGate();
    const a = deferred<void>();
    const ta = gate.issue();
    const tb = gate.issue();

    const runA = gate.enter(async () => {
      await a.promise;
    }, ta);
    await Bun.sleep(10);

    // B 仍排队：release 不摘（客户端断开，运行照常语义）
    gate.release(tb);
    expect(gate.queuedCount).toBe(1);

    a.resolve();
    await runA;
    gate.release(ta); // 终态清理（防御性：map 早已在开跑时摘除）
    expect(gate.queuedCount).toBe(1); // B 仍在队（等它的轮到）
  });

  test("fn 失败不堵队列（链式吞错，后续轮照常执行）", async () => {
    const gate = new AskGate();
    const order: string[] = [];

    const runA = gate.enter(async () => {
      order.push("A");
      throw new Error("引擎失败");
    }, gate.issue());
    const runB = gate.enter(async () => {
      order.push("B");
    }, gate.issue());

    await runA.catch(() => undefined);
    await runB;
    expect(order).toEqual(["A", "B"]);
    expect(gate.busy).toBe(false);
  });

  test("票据 id 唯一递增（open 事件回显的会话身份）", () => {
    const gate = new AskGate();
    const ids = [gate.issue().id, gate.issue().id, gate.issue().id];
    expect(ids[1]!).toBe(ids[0]! + 1);
    expect(ids[2]!).toBe(ids[1]! + 1);
    expect(gate.queuedCount).toBe(3);
  });
});
