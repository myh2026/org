// ============================================================================
// org/web/gate.ts — ask 串行门 + 排队票据（v0.4.14：排队轮可预先取消）
// ----------------------------------------------------------------------------
// 背景：direct 流水线固定写 workspace/out-ask（与 org ask 同产物约定），
// 并发运行会互踩产物目录 —— 原型用单飞队列（一次一轮）。此前的纯
// promise 链没有句柄：排队中的第二轮既无法撤回、也可能被「停止」误伤
// 前一轮（abort 只认 runningProc）。本模块给每轮发票据：
//   issue()   排队取票（open 事件回显 ticketId 给前端）
//   enter()   轮到时执行 fn；票据已取消则拒绝执行（QueueCancelledError，
//             不占流水线、不落账本）
//   cancel()  按 id 取消排队轮 → "cancelled"；命中运行轮 → "running"
//             （端点据此走 SIGKILL 传统路径）；查无此票 → "unknown"
//   release() SSE 流终结时清理（排队中的票据不动：断开不中止运行，
//             账本是事实源 —— 与「客户端意外断开轮次照常落盘」同一语义）
// 临界区说明：enter 回调的「查取消 → 置 running → 摘票」是同步块，JS
// 单线程事件循环保证与 cancel() 无交织。
// ============================================================================

/** 排队轮被取消（轮到时拒绝执行；SSE 端点转写为 error{aborted,queued}）。 */
export class QueueCancelledError extends Error {
  constructor() {
    super("已取消排队：本轮未开始");
    this.name = "QueueCancelledError";
  }
}

export type AskTicketState = "queued" | "running" | "done" | "cancelled";

export interface AskTicket {
  readonly id: number;
  state: AskTicketState;
}

export type CancelResult = "cancelled" | "running" | "unknown";

export class AskGate {
  private chain: Promise<unknown> = Promise.resolve();
  private tickets = new Map<number, AskTicket>();
  private seq = 0;
  /** 供 open 事件诚实告知「排队中」（与旧 askBusy 语义一致）。 */
  busy = false;
  /** 当前运行轮（cancel 命中它时返回 "running" → 端点走 SIGKILL 路径）。 */
  current: AskTicket | null = null;

  /** 发票：排队轮登记入表（id 唯一递增；open 事件回显给前端）。 */
  issue(): AskTicket {
    const t: AskTicket = { id: ++this.seq, state: "queued" };
    this.tickets.set(t.id, t);
    return t;
  }

  /** 入队执行：轮到且未被取消时才跑 fn（FIFO；fn 的成败不影响后续轮）。 */
  enter<T>(fn: () => Promise<T>, ticket: AskTicket): Promise<T> {
    const run = this.chain.then(() => {
      if (ticket.state === "cancelled") throw new QueueCancelledError();
      // 同步临界区：置 running + 摘票（与 cancel() 的互斥由单线程保证）
      ticket.state = "running";
      this.tickets.delete(ticket.id);
      this.current = ticket;
      this.busy = true;
      return fn().finally(() => {
        this.busy = false;
        if (this.current === ticket) this.current = null;
        ticket.state = "done";
      });
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 按 id 取消：只对排队轮有效（运行轮的取消走 SIGKILL，由端点处理）。 */
  cancel(id: number): CancelResult {
    const t = this.tickets.get(id);
    if (t) {
      t.state = "cancelled";
      this.tickets.delete(id);
      return "cancelled";
    }
    return this.current && this.current.id === id ? "running" : "unknown";
  }

  /** 流终结清理：排队中的票据不摘（断开 ≠ 取消，轮次照常落账本）。 */
  release(ticket: AskTicket): void {
    if (ticket.state !== "queued") this.tickets.delete(ticket.id);
  }

  /** 排队深度（诊断面：status/端点可暴露；0 表示空闲或仅运行轮）。 */
  get queuedCount(): number {
    return this.tickets.size;
  }
}
