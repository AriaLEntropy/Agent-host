# BotBus 契约副本（vendored）

根目录下的 `protocol.ts` 和 `protocol-fixtures/` 是 `botbus-protocol` 仓库的**只读副本**，只为让本仓库自己就能跑测试，不需要并列 clone 上游仓库。`extensions/` 不是副本，是本仓库自己的私有扩展（见下文）。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/botbus-io/botbus-protocol |
| 提交 | `9389165f46b1fc1aa929bcdd7f5fae9484241113`（2026-10-06，`Sync from app repository (172bf42)`） |
| 许可证 | Apache-2.0（见 `NOTICE`） |
| 来源路径 | `src/protocol.ts` → `protocol.ts`；`protocol-fixtures/plain/` → `protocol-fixtures/plain/` |

## 用途

- `protocol.ts`：官方 zod schema。测试用 `Snapshot.safeParse(...)` 校验 `/bus/snapshot` 的真实输出（`test/bus/router.test.ts`、`test/connectors/runtime.test.ts`）。
- `protocol-fixtures/plain/`：官方样本。`test/bus/plain-commands.test.ts` 逐个喂给 `acceptCommand`，确认每一条命令都能被受理并产出结果。

## 本地扩展（extensions/）

`extensions/` 里的东西是**我们自己的**，不是上游副本；同步上游时保留，也不要拷回上游。

| 目录 | 内容 |
|---|---|
| `extensions/skills-3.10/` | `fetchSkills` / `readSkill` 命令与 `skillList` / `skillContent` 事件（BotBus 3.10） |

- 上游当前是 3.9，没有技能命令；本仓库 Host 和手机端已经按 3.10 实现并自用。
- 扩展的 schema、样本和密封往返由 `test/bus/skills-3.10-fixtures.test.ts` 覆盖，和官方样本分开跑。
- 同步上游只会覆盖 `protocol.ts` 与 `protocol-fixtures/plain/`，不会动 `extensions/`。
- 如果上游将来自己发布了内容不同的 3.10，先对齐语义，再决定把本扩展并回去、改号或删掉。

## 注意

- **不要改 vendored 文件**（`protocol.ts`、`protocol-fixtures/`）。要改公共协议就先改上游仓库，再同步过来，否则手机端和电脑端会各说各话；只在本仓库用的扩展放 `extensions/`。
- `protocol.ts` 依赖 `zod`，本仓库把它放在 `devDependencies`；如果将来要在 `src/` 里做运行时校验，需要把 `zod` 挪到 `dependencies`。
- 同步后要一起改：`src/bus/router.ts` 的 `PROTOCOL_VERSION`、本文件里的提交号、`protocol.ts` 头部的提交号。

## 同步步骤（有上游仓库时）

```powershell
# 假设上游在 ..\botbus-protocol
Copy-Item ..\botbus-protocol\src\protocol.ts .\protocol.ts
Remove-Item -Recurse -Force .\protocol-fixtures\plain
Copy-Item -Recurse ..\botbus-protocol\protocol-fixtures\plain .\protocol-fixtures\plain
# 再手动把 protocol.ts 顶部 4 行来源注释补回去（提交号改成新的）
```

同步完跑 `npm test` 和 `npx tsc -p test/tsconfig.json`。
