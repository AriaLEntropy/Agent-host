# BotBus 3.10 — Skills

状态：本仓库私有扩展（BotBus 3.10）。Agent-host 与移动端都已实现并自用，暂不提交上游；
样本和 schema 保留在 `test/contract/extensions/skills-3.10/`。

## 新增命令

### fetchSkills

```json
{
  "connector": "acp | claude | codex | ...",
  "connectorId": "qwen-code",
  "projectPath": "/Users/me/Projects/demo",
  "taskId": "acp:qwen-code:sess_7f3a2c"
}
```

- `connector` 必填；`acp` 必须带 `connectorId`，其他来源必须省略。
- `projectPath` 是草稿态的已知项目；空串表示用户级技能目录。
- `taskId` 可选；带上时电脑会用会话命令补全列表，并重新校验任务归属。
- 结果不进 `CommandResult`，而是发一个 `skillList` 事件。
- 手机打开技能面板时刷新；电脑每次重新扫描文件目录，不长期缓存。

### readSkill

```json
{
  "connector": "acp",
  "connectorId": "qwen-code",
  "projectPath": "/Users/me/Projects/demo",
  "taskId": "acp:qwen-code:sess_7f3a2c",
  "skillId": "sk_7f3a2c1d9e8b6a4c0d2f1a"
}
```

- `skillId` 是 `fetchSkills` 返回的不透明 id，不接受客户端传路径。
- 电脑重新构建目录并确认 id 仍存在；失效回 `ok:false` `"skill not found"`。
- ACP 命令 `hasBody=false`，回 `"skill content is not available"`；只有文件型技能能读正文。
- 结果发一个 `skillContent` 事件。

## 结果事件

### skillList

```json
{
  "commandId": "9d1f0c2a-6b7e-4a5d-8c31-2f4e6a8b0c1d",
  "agentId": "hV3nQ7pLxK2mR8sTfW4bZQ",
  "connector": "acp",
  "connectorId": "qwen-code",
  "projectPath": "/Users/me/Projects/demo",
  "taskId": "acp:qwen-code:sess_7f3a2c",
  "revision": "9b2f4c6d8e0a1b3c",
  "skills": [
    {
      "id": "ac_7f3a2c1d9e8b6a4c0d2f1a",
      "name": "release",
      "description": "Write release notes from commits",
      "hint": "version",
      "kind": "command",
      "source": "session",
      "hasBody": false
    },
    {
      "id": "sk_7f3a2c1d9e8b6a4c0d2f1a",
      "name": "review",
      "description": "Review a change before merging",
      "kind": "skill",
      "source": "project",
      "hasBody": true
    }
  ],
  "truncated": false,
  "fetchedAt": "2026-11-03T05:10:01Z"
}
```

- `skills` 整份替换、保序；同名时会话命令优先于文件技能。
- 上限 100 条；超了置 `truncated:true`。
- `source`：`session`（ACP 命令）/ `project` / `user` / `agent`。
- `kind`：`command` 或 `skill`；手机据此决定是否显示「查看」。
- `revision` 是电脑算的目录指纹；手机可用它丢弃乱序响应。
- 事件会广播给同组手机；旧客户端必须能忽略未知 Event.Kind（本仓库都是忽略）。

### skillContent

```json
{
  "commandId": "4c8a1e6f-2d3b-4a9c-8e7f-1b0d2c3a4e5f",
  "agentId": "hV3nQ7pLxK2mR8sTfW4bZQ",
  "skillId": "sk_7f3a2c1d9e8b6a4c0d2f1a",
  "name": "review",
  "contentType": "text/markdown",
  "body": "# Review\n\nRead the diff, check the tests, then leave a short summary.\n",
  "truncated": false,
  "fetchedAt": "2026-11-03T05:10:03Z"
}
```

- 正文上限 64 KiB；超了按 UTF-8 边界截断并置 `truncated:true`。

## 能力声明

`ConnectorInfo.canListSkills: true`，只写 true；没有这个字段 = 不支持。

不要加进 `HostCapabilities`：那个对象的既有语义是「省略 = 支持」（为了兼容旧 Mac），
新能力放进去会被旧电脑误判为支持。

## 密封形状（3.10 提案）

Relay 只路由密文；新增 Event.Kind 需要在 `SealedTypes.swift` / `seal-fixtures.mjs` 里补：

```text
SealedSkillList {
  commandId: string
  agentId: string
  fetchedAt: string
  sealed: Sealed        // 明文是 SkillList
}
AAD: skills:<agentId>:<commandId>

SealedSkillContent {
  commandId: string
  agentId: string
  skillId: string
  fetchedAt: string
  sealed: Sealed        // 明文是 SkillContent
}
AAD: skill:<agentId>:<skillId>
```

`SealedEvent` 的 `kind` 明文增加 `skillList` / `skillContent`，配套字段是上面的密封形状。
如果不希望新增 Event.Kind，另一条路是把结果做成 JSON 产物，用 `CommandResult.artifactId`
回传（`fetchChanges` 的模式）；那样不需要新增 Event.Kind，但手机要多一次产物下载。

## 版本与发布顺序

- 协议 3.10；`CommandKind` 和 `Event.Kind` 都是冻结枚举，必须更新 `ProtocolFreezeTests`。
- 新增命令只由新手机发出；旧电脑没有 `canListSkills`，手机不发。
- 旧手机收到新 Event.Kind 必须忽略或按版本抬线；本仓库的 `BusStore` 忽略未知 kind。
- 发布顺序：手机 3.10 → 电脑 3.10。本仓库手机端连接门槛仍是 3.9（3.10 只加能力，不抬高门槛）；
  旧手机收到未知 Event.Kind 必须忽略，本仓库 `BusStore` 就是忽略。
- Relay 3.x 命令种类在密文里，不用改；如果部署的 Relay 有 kind 白名单，先加。

## 生命周期

- `available_commands_update` 是整份替换；`session/load` / `resume` / fork / `restartConnector` 后清空，等 agent 重发。
- ACP v1 的 `available_commands_update` 常在 `session/new` 后立刻到；电脑要按 sessionId 缓冲早期 update，否则会丢第一份列表。
- 草稿态没有 ACP session，列表只有文件型技能；会话命令要等第一条消息创建 session 后才出现。
- 文件技能每次 `fetchSkills` 重新扫描；`readSkill` 不信任客户端路径，只接受目录里出现过的 id。
