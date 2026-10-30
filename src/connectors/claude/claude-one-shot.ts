// Ported from botbus-protocol/Sources/BotBusConnectorKit/OneShotContinuation.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

/**
 * 独占一个一次性结果：谁先落定谁生效，其余静默丢弃。
 *
 * 挂起的 HTTP 响应有三条路径抢同一个出口——被回答、超时、连接断开；
 * 这个盒子保证第二条路径不会改变结果。
 */
export class OneShot<T> {
  private settled = false;
  private readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  /** 第一个调用者生效并返回 true，其余返回 false。 */
  resolve(value: T): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.resolvePromise(value);
    return true;
  }

  /** 第一个调用者生效并返回 true，其余返回 false。 */
  reject(error: Error): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.rejectPromise(error);
    return true;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  value(): Promise<T> {
    return this.promise;
  }
}
