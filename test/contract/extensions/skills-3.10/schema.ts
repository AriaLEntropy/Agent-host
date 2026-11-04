import { z } from "zod";
import { AcpConnectorId, ConnectorKind } from "../../protocol.js";

// BotBus 3.10 本地扩展：技能发现与正文读取。
// 上游 3.9 的 Command / Event 里还没有这两个命令和两个事件，所以这里单独定义。
// vendored 的 protocol.ts 保持原样，同步上游时本目录整份保留。

export const SkillKind = z.enum(["skill", "command"]);
export const SkillSource = z.enum(["session", "project", "user", "agent"]);

export const BusSkill = z.object({
  /** 电脑生成的不透明 id，客户端不能从中推路径 */
  id: z.string().min(1).max(128),
  /** 斜杠命令名，不带前导 / */
  name: z.string().min(1).max(64),
  description: z.string().max(1024),
  /** ACP 命令的 input.hint，没有就省略 */
  hint: z.string().max(200).optional(),
  kind: SkillKind,
  source: SkillSource,
  /** 只有文件型技能为 true，readSkill 能读正文 */
  hasBody: z.boolean(),
});

const SkillQueryBase = z.object({
  connector: ConnectorKind,
  connectorId: AcpConnectorId.optional(),
  /** 草稿态的已知项目；空串表示用户级技能目录 */
  projectPath: z.string(),
  taskId: z.string().min(1).optional(),
});

/** connectorId 只跟 acp 一起出现，而且 acp 必须带它 */
function skillQueryRule(
  value: { connector: string; connectorId?: string },
  ctx: z.RefinementCtx,
) {
  const isAcp = value.connector === "acp";
  if (isAcp !== (value.connectorId !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["connectorId"],
      message: "connectorId is required for acp and only allowed there",
    });
  }
}

export const FetchSkillsPayload = SkillQueryBase.superRefine(skillQueryRule);

export const ReadSkillPayload = SkillQueryBase.extend({
  skillId: z.string().min(1).max(128),
}).superRefine(skillQueryRule);

/** 命令的公共外壳和上游一致：id / createdAt / agentId / kind / 载荷 */
const CommandShell = {
  id: z.string().min(1),
  createdAt: z.string().min(1),
  agentId: z.string().min(1),
};

export const SkillCommand = z.discriminatedUnion("kind", [
  z.object({ ...CommandShell, kind: z.literal("fetchSkills"), fetchSkills: FetchSkillsPayload }),
  z.object({ ...CommandShell, kind: z.literal("readSkill"), readSkill: ReadSkillPayload }),
]);

export const SkillList = z.object({
  commandId: z.string().min(1),
  agentId: z.string().min(1),
  connector: ConnectorKind,
  connectorId: AcpConnectorId.optional(),
  projectPath: z.string(),
  taskId: z.string().optional(),
  /** 电脑算的目录指纹，手机用它丢弃乱序响应 */
  revision: z.string().min(1).max(64),
  skills: z.array(BusSkill).max(100),
  truncated: z.boolean(),
  fetchedAt: z.string().min(1),
}).superRefine(skillQueryRule);

export const SkillContent = z.object({
  commandId: z.string().min(1),
  agentId: z.string().min(1),
  skillId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  contentType: z.literal("text/markdown"),
  body: z.string(),
  truncated: z.boolean(),
  fetchedAt: z.string().min(1),
});

export const SkillEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skillList"), skillList: SkillList }),
  z.object({ kind: z.literal("skillContent"), skillContent: SkillContent }),
]);
