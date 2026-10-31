/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/OutsideProjectRule.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 哪些工作目录"不算项目"（协议 2.6 `Task.outsideProject`）。
 *
 * 为什么在电脑上判定而不是手机上：主目录在哪、各 Agent 的默认工作区在哪，只有本机知道；
 * 手机只能对着 `C:\Users\xxx` 这种形状去猜，换一个平台就不成立。
 *
 * 规则故意只认几个固定位置，不看目录里有没有 `.git`——很多正经项目并不用 git，
 * 按仓库判断会把它们误判成"不在项目中"。这里认的目录本身不算项目，**它们的子目录照常算**。
 */
import { homedir } from "node:os";
import { platformPath, type PlatformPathApi } from "./path.js";

export type OutsideProjectRuleOptions = {
  homeDirectory?: string;
  /** 各来源的默认工作区（没指定目录时会话落在这里）。目前只有 OpenClaw 有。 */
  agentWorkspaces?: Readonly<Record<string, string | undefined>>;
  /** 手机新建项目时的存放目录（协议 2.6 `AgentInfo.projectsRoot`）。它本身不是项目，它下面的子文件夹才是。 */
  projectsRoot?: string | null;
  /** 测试注入用；默认按当前平台。 */
  paths?: PlatformPathApi;
};

export class OutsideProjectRule {
  readonly homeDirectory: string;
  readonly agentWorkspaces: Readonly<Record<string, string | undefined>>;
  readonly projectsRoot?: string;
  private readonly paths: PlatformPathApi;

  /** 主目录下本身不算项目的那几个目录。 */
  static readonly homeSubdirectories = ["Desktop", "Downloads", "Documents"] as const;

  constructor(options: OutsideProjectRuleOptions = {}) {
    this.paths = options.paths ?? platformPath;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.agentWorkspaces = options.agentWorkspaces ?? {};
    this.projectsRoot = options.projectsRoot ?? undefined;
  }

  /**
   * Windows：系统盘根与临时目录。POSIX：`/`、`/tmp`、`/private/tmp`。
   * 每次读环境变量，测试可以用 `TEMP` 等注入。
   */
  systemDirectories(): string[] {
    const environment = process.env;
    if (this.paths.platform === "win32") {
      const directories = [`${environment.SystemDrive ?? "C:"}\\`];
      for (const key of ["TEMP", "TMP"]) {
        const value = environment[key];
        if (value) directories.push(OutsideProjectRule.normalized(value, "", this.paths));
      }
      return directories;
    }
    return ["/", "/tmp", "/private/tmp"];
  }

  /** 这个路径是否不算项目。空串（没有目录）也算。 */
  contains(path: string): boolean {
    const home = OutsideProjectRule.normalized(this.homeDirectory, "", this.paths);
    const target = OutsideProjectRule.normalized(path, home, this.paths);
    if (!target) return true;
    if (this.systemDirectories().some((directory) => this.paths.same(directory, target))) {
      return true;
    }
    if (home) {
      if (this.paths.same(target, home)) return true;
      if (
        OutsideProjectRule.homeSubdirectories.some((name) =>
          this.paths.same(target, this.paths.join(home, name)),
        )
      ) {
        return true;
      }
    }
    const others = [...Object.values(this.agentWorkspaces), this.projectsRoot].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return others.some(
      (directory) =>
        this.paths.same(OutsideProjectRule.normalized(directory, home, this.paths), target),
    );
  }

  /**
   * 去掉首尾空白与末尾的 `/`，开头的 `~` 按规则里的主目录展开（不读进程环境，测试才能注入）。
   * 根目录 `/` 保持原样。Windows 上分隔符统一成 `\`（盘符根 `C:\` 保持原样）。
   */
  static normalized(path: string, home: string, paths: PlatformPathApi = platformPath): string {
    let value = path.trim();
    if (home) {
      if (value === "~" || value.startsWith("~/")) value = home + value.slice(1);
      else if (paths.platform === "win32" && value.startsWith("~\\")) {
        value = home + value.slice(1);
      }
    }
    return value ? paths.normalized(value) : value;
  }
}
