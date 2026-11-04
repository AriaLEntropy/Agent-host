# BotBus 3.10 私有扩展（skills）

技能发现与正文读取：`fetchSkills` / `readSkill` 两个命令，`skillList` / `skillContent` 两个事件。
本仓库的 Host 和手机端都已实现，`PROTOCOL_VERSION` 是 `3.10`。

## 为什么放在这里

`botbus-protocol` 上游停在 3.9，没有技能命令。我们只在自家两端用，暂不打算提上游，
所以不修改 vendored 副本，也不往 `protocol-fixtures/plain/` 里塞样本——那个目录在同步上游时会被整份覆盖。

`extensions/` 是本仓库自己的目录，同步上游时保留，不要拷回上游。

## 目录

```text
plain/                         明文样品
  command-fetch-skills.json
  command-read-skill.json
  event-skill-list.json
  event-skill-content.json
  invalid/                     必须被 schema 拒绝的反例
sealed/                        已生成的密封命令样品（事件密封形状见 PROTOCOL-3.10.md）
schema.ts                      本地 zod schema，复用 vendored protocol.ts 的 ConnectorKind
seal.ts                        夹具专用密封工具（确定性 nonce，规则同上游 seal-fixtures.mjs）
PROTOCOL-3.10.md               命令/事件形状、能力声明、密封形状、兼容与发布顺序
```

## 测试

`Agent-host/test/bus/skills-3.10-fixtures.test.ts` 会：

- 用 `schema.ts` 接受 4 个合法样本、拒绝 6 个反例；
- 用固定根密钥解开 `sealed/` 里的命令，与明文逐键相等；
- 重新密封后与密封样本逐字节相等；
- 确认这些样本仍然不被 vendored 的 3.9 `Command` / `Event` 接受。上游如果哪天自己发布了技能命令，
  这条会先失败，提醒我们把扩展并回去或改号。

运行：

```powershell
cd Agent-host
npx tsx --test test/bus/skills-3.10-fixtures.test.ts
```

## 和 vendored 副本的关系

- `test/contract/protocol.ts` 和 `test/contract/protocol-fixtures/plain/` 是上游只读副本，不要改。
- 3.10 的 schema 与样本只在本目录；Host 运行时不做 zod 校验，两端靠这份样本和各自测试对齐。
- 上游将来若自己发布内容不同的 3.10，先对齐语义；必要时把本扩展改号到 3.11。

## 如果将来要提上游

样本和 schema 都是现成的：把 `plain/`、`plain/invalid/` 拷进上游对应目录，把 `schema.ts` 的形状并入
上游 `protocol.ts`，按 `PROTOCOL-3.10.md` 补 `SealedTypes.swift` 与 `seal-fixtures.mjs` 的事件密封形状，
再跑上游的冻结测试和 `node scripts/seal-fixtures.mjs`。
