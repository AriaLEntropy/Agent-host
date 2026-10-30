// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexSubprocess.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { type ChildProcess } from "node:child_process";
import { spawnExecutable } from "../ported/spawn.js";
import { AgentBinary, CodexPaths, isExecutableFile, resolveSymlinks } from "./paths.js";
import { CodexAppServerError, type CodexProcessExit } from "./app-server-messages.js";
import type { CodexProcessHandle, CodexProcessLauncher } from "./app-server.js";

/** stdout 的异步字节队列：一次 read 可能给半行，也可能给几行，由上层按换行分帧。 */
class StdoutQueue {
  private readonly buffer: Buffer[] = [];
  private readonly waiters: Array<(chunk: Buffer | null) => void> = [];
  private closed = false;

  push(chunk: Buffer): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.buffer.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<Buffer | null> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class ExitBox {
  private resolved = false;
  private resolvePromise: ((value: CodexProcessExit) => void) | undefined;
  readonly promise: Promise<CodexProcessExit>;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: CodexProcessExit): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolvePromise?.(value);
  }
}

/**
 * 生产用的启动器：真的 fork 一个 `codex app-server` 出来。
 *
 * 二进制位置由 `CodexPaths.detectCodexBinary()` 按 ChatGPT / Codex app 的新旧包结构探测。
 * **测试一律不用它**——全套测试走 `CodexProcessHandle` 的假实现，不起进程、不碰 `~/.codex`。
 */
export class CodexSubprocessLauncher implements CodexProcessLauncher {
  readonly executablePath: string;
  readonly arguments: string[];
  /** undefined = 继承当前进程的环境（codex 要靠它找 `CODEX_HOME` 与登录态）。 */
  readonly environment?: NodeJS.ProcessEnv;
  readonly currentDirectory?: string;
  /** Desktop helper uses the desktop's stderr directly; ordinary Agent mode keeps a tail. */
  forwardStderr = false;

  constructor(
    executablePath: string,
    args: string[] = ["app-server"],
    environment?: NodeJS.ProcessEnv,
    currentDirectory?: string,
  ) {
    this.executablePath = executablePath;
    this.arguments = args;
    this.environment = environment;
    this.currentDirectory = currentDirectory;
  }

  /** 按 `CodexPaths` 的优先级找一个能用的 codex；一个都没有时返回 undefined。 */
  static detected(): CodexSubprocessLauncher | undefined {
    const path = CodexPaths.detectCodexBinary();
    if (!path) return undefined;
    // npm 装的 `codex.js` 是 `#!/usr/bin/env node` 脚本：GUI 进程的 PATH 里多半没有 node，把它旁边的放到最前。
    const script = path.endsWith(".js") || resolveSymlinks(path).endsWith(".js");
    return new CodexSubprocessLauncher(path, ["app-server"], script ? AgentBinary.environmentFor(path) : undefined);
  }

  async launch(): Promise<CodexProcessHandle> {
    return CodexSubprocess.create(
      this.executablePath,
      this.arguments,
      this.environment,
      this.currentDirectory,
      this.forwardStderr,
    );
  }
}

/**
 * 一个真实的 `codex app-server` 子进程：stdout 走异步字节队列，stdin 串行写（整行原子写），
 * stderr 只留最后一小段用于界面提示——**不进日志**，那里面可能有用户的内容。
 */
export class CodexSubprocess implements CodexProcessHandle {
  /** stderr 只留这么多字节（取末尾）。 */
  private static readonly stderrTailLimit = 4096;
  private static readonly exitReasonLimit = 200;

  private readonly child: ChildProcess;
  private readonly stdoutQueue = new StdoutQueue();
  private readonly exitBox = new ExitBox();
  private stderrTail = Buffer.alloc(0);
  private stdinClosed = false;
  /** 所有写都串到这条链上：两条并发请求交错成半行的话，对端会直接解析失败。 */
  private writeChain: Promise<void> = Promise.resolve();
  private exited = false;
  private readonly forwardStderr: boolean;

  private constructor(child: ChildProcess, forwardStderr: boolean) {
    this.child = child;
    this.forwardStderr = forwardStderr;
  }

  static async create(
    executablePath: string,
    args: string[],
    environment: NodeJS.ProcessEnv | undefined,
    currentDirectory: string | undefined,
    forwardStderr: boolean,
  ): Promise<CodexSubprocess> {
    const child = spawnExecutable(executablePath, args, {
      env: environment,
      cwd: currentDirectory,
      stdio: ["pipe", "pipe", forwardStderr ? "inherit" : "pipe"],
      windowsHide: true,
    });
    const instance = new CodexSubprocess(child, forwardStderr);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error: unknown) => {
      // 可执行文件根本不在：手机上说「电脑上找不到 Codex」，而不是一串启动错误。
      const diagnosis = isExecutableFile(executablePath) ? undefined : { kind: "agentNotInstalled" };
      throw new CodexAppServerError(
        "launchFailed",
        `无法启动 ${executablePath}：${error instanceof Error ? error.message : String(error)}`,
        { diagnosis },
      );
    });

    instance.attach();
    console.info(`[codexsubprocess] codex app-server pid=${child.pid ?? "?"}`);
    return instance;
  }

  private attach(): void {
    this.child.stdout?.on("data", (chunk: Buffer) => this.stdoutQueue.push(chunk));
    this.child.stdout?.on("end", () => this.stdoutQueue.close());
    this.child.stdout?.on("error", () => this.stdoutQueue.close());
    if (!this.forwardStderr) {
      this.child.stderr?.on("data", (chunk: Buffer) => this.appendStderr(chunk));
      this.child.stderr?.on("error", () => undefined);
    }
    this.child.on("error", (error) => {
      console.error(`[codexsubprocess] codex app-server 出错：${error.message}`);
      if (!this.exited) {
        this.exited = true;
        this.stdoutQueue.close();
        this.exitBox.resolve({ status: -1, reason: this.takeStderrTail() });
      }
    });
    this.child.on("close", (code) => {
      this.exited = true;
      // 进程没了：stdin 再写也没人读，写端关掉。
      this.closeStdin();
      // 孙进程攥着 stdout 时 EOF 不来；退出后再等 2 秒就不读了。
      const timer = setTimeout(() => this.stdoutQueue.close(), 2000);
      timer.unref?.();
      this.stdoutQueue.close();
      this.exitBox.resolve({ status: code ?? -1, reason: this.takeStderrTail() });
    });
  }

  async readStdout(): Promise<Uint8Array | null> {
    return this.stdoutQueue.next();
  }

  writeStdin(data: Uint8Array): Promise<void> {
    const task = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.stdinClosed || !this.child.stdin) {
            reject(new CodexAppServerError("notRunning", "子进程的 stdin 已经关了"));
            return;
          }
          this.child.stdin.write(data, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  terminate(): void {
    if (this.exited) return;
    this.closeStdin();
    // PORT：Swift 的 Process.terminate() 只给直接子进程发信号；Node 在 Windows 上同理，
    // 不会额外杀整棵进程树（codex 自己起的 shell 由它自己收尾）。
    try {
      this.child.kill();
    } catch {
      // 已经退出：忽略。
    }
  }

  /** 幂等。排在已经在队里的写之后关，不会撞上一次正在进行的写。 */
  private closeStdin(): void {
    this.writeChain = this.writeChain
      .then(() => {
        if (this.stdinClosed) return;
        this.stdinClosed = true;
        try {
          this.child.stdin?.end();
        } catch {
          // 管道已断：忽略。
        }
      })
      .catch(() => undefined);
  }

  waitForExit(): Promise<CodexProcessExit> {
    return this.exitBox.promise;
  }

  private appendStderr(data: Buffer): void {
    this.stderrTail = Buffer.concat([this.stderrTail, data]);
    if (this.stderrTail.length > CodexSubprocess.stderrTailLimit) {
      this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - CodexSubprocess.stderrTailLimit);
    }
  }

  /** 给界面看的一句话。**只在这里出现，不写进日志**。 */
  private takeStderrTail(): string | undefined {
    const data = this.stderrTail;
    this.stderrTail = Buffer.alloc(0);
    if (data.length === 0) return undefined;
    const lines = data.toString("utf8").split("\n");
    const text = lines[lines.length - 1]?.trim();
    if (!text) return undefined;
    return text.slice(0, CodexSubprocess.exitReasonLimit);
  }
}
