# BotBus 契约副本（vendored）

这个目录是 `botbus-protocol` 仓库的**只读副本**，只为让本仓库自己就能跑测试，不需要并列 clone 上游仓库。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/botbus-io/botbus-protocol |
| 提交 | `9389165f46b1fc1aa929bcdd7f5fae9484241113`（2026-10-06，`Sync from app repository (172bf42)`） |
| 许可证 | Apache-2.0（见 `NOTICE`） |
| 来源路径 | `src/protocol.ts` → `protocol.ts`；`protocol-fixtures/plain/` → `protocol-fixtures/plain/` |

## 用途

- `protocol.ts`：官方 zod schema。测试用 `Snapshot.safeParse(...)` 校验 `/bus/snapshot` 的真实输出（`test/bus/router.test.ts`、`test/connectors/runtime.test.ts`）。
- `protocol-fixtures/plain/`：官方样本。`test/bus/plain-commands.test.ts` 逐个喂给 `acceptCommand`，确认每一条命令都能被受理并产出结果。

## 注意

- **不要在这里改协议**。要改就先改上游仓库，再同步过来，否则手机端和电脑端会各说各话。
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
