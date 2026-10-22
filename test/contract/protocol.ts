// Vendored from botbus-protocol (Apache-2.0), do not edit in place.
// Source: https://github.com/botbus-io/botbus-protocol
// Commit: 9389165f46b1fc1aa929bcdd7f5fae9484241113 (2026-10-06, "Sync from app repository (172bf42)")
// Upstream path: src/protocol.ts -- re-copy from upstream and update this header when syncing.
import { z } from "zod";

// ---- Task ----
export const TaskStatus = z.enum([
  "running", "waitingApproval", "waitingInput", "completed", "failed", "interrupted", "idle",
]);
/**
 * 协议 2.5 起加入 hermes / pi / openclaw，2.13 起加入 acp（所有 ACP agent 共用，用 connectorId   区分），
 * 3.1 起加入 dsh（DeepSeek Harness，一档，不带 connectorId）。
 */
export const TaskSource = z.enum(["codex", "claude", "hermes", "pi", "openclaw", "acp", "dsh"]);

/**
 * 协议 3.2：模型 id 与思考强度，与 Swift 的 `ModelOption.isValidId` / `isValidEffort` 一致。
 * 它们会成为 agent 命令行的参数值，所以不能以 `-` 开头。
 */
export const ModelId = z.string().regex(/^(?!-)[A-Za-z0-9._:/-]{1,64}$/);
export const ModelEffort = z.string().regex(/^(?!-)[a-z0-9-]{1,16}$/);
export const MAX_MODELS = 24;
export const MAX_MODEL_EFFORTS = 8;

/** 协议 2.13：ACP agent 的 id，与 Swift 的 `ConnectorRef.isValidAcpId` 一致。不含冒号，任务 id 才切得开。 */
export const AcpConnectorId = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** `connectorId` 只跟 acp 一起出现，而且 acp 必须带它。 */
function acpConnectorIdRule(isAcp: boolean, connectorId: string | undefined, ctx: z.RefinementCtx) {
  if (isAcp !== (connectorId !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["connectorId"],
      message: "connectorId is required for acp and only allowed there",
    });
  }
}

export const TaskOrigin = z.enum(["watch", "desktop"]);

/** 协议 2.14：带选项的提问。生产方负责截断到这些上限。 */
export const MAX_PENDING_QUESTIONS = 8;
export const MAX_QUESTION_OPTIONS = 16;

export const PendingOption = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const PendingQuestion = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  /** 单选时整个键省略。 */
  multiSelect: z.literal(true).optional(),
  options: z.array(PendingOption).max(MAX_QUESTION_OPTIONS),
});

export const PendingRequest = z.object({
  id: z.string(),
  kind: z.enum(["command", "fileChange", "permission", "input"]),
  summary: z.string(),
  detail: z.string().optional(),
  question: z.string().optional(),
  /** 协议 2.14：只随 kind = input 出现。 */
  questions: z.array(PendingQuestion).min(1).max(MAX_PENDING_QUESTIONS).optional(),
});

// ---- Artifact（协议 2.3，2.9 加 video） ----
/** 闭集：遇未知值拒绝整条，与其他枚举一致。 */
export const ArtifactKind = z.enum(["image", "file", "preview", "link", "video"]);

/** image / file / link / video 的 id：Agent 生成的 22 字符 base64url（16 随机字节）。 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** preview 的 id：Relay 分配的 26 字符小写 base32，同时是预览主机名 `p-<id>` 的一部分。 */
export const PREVIEW_ID_PATTERN = /^[a-z2-7]{26}$/;
/** 产物标题上限，生产方负责截断。 */
export const MAX_ARTIFACT_TITLE_LENGTH = 80;
/** 单个任务最多挂这么多产物。 */
export const MAX_TASK_ARTIFACTS = 10;

/**
 * agent 回传给手机的一件产物。解码只校验字段类型与 `kind` 闭集；
 * "某 kind 必填某字段"（image/file 的 `contentType` 与 `size`、link 的 `url`、preview 的 `expiresAt`）
 * 由生产方（Agent）保证，消费方遇缺失按"不可用"显示——一件坏产物不该让整份快照被拒。
 * 因此 `id` 也不按 kind 校验格式。
 */
export const Artifact = z.object({
  id: z.string(),
  kind: ArtifactKind,
  title: z.string(),
  createdAt: z.string(),
  /** image / file 必填，如 `image/png`。 */
  contentType: z.string().optional(),
  /** image / file 必填，字节数。 */
  size: z.number().int().optional(),
  /** link 必填，`http` / `https`。 */
  url: z.string().optional(),
  /** preview 来自端口时填写（1–65535）；来自静态目录时省略。 */
  port: z.number().int().optional(),
  /** preview 必填；image / file / video 可选（Relay 侧 TTL 到期时间）。 */
  expiresAt: z.string().optional(),
  /** video 可选：封面图的产物 id（另一件 kind = image 的产物）。 */
  posterId: z.string().regex(ARTIFACT_ID_PATTERN).optional(),
  /** video 可选：时长，秒。 */
  duration: z.number().nonnegative().optional(),
  /** 协议 3.0：preview 可选，只发 true 或省略——这份预览是远程操作的电脑屏幕（在密文里，Relay 看不到）。 */
  remoteControl: z.boolean().optional(),
});

/**
 * 协议 2.10：失败后发现的系统授权弹窗历史证据，不证明失败原因或当前仍待处理。
 * dialogText 是原始弹窗文字，由生产方限制长度；客户端负责本地化说明。
 */
export const SystemPermissionNotice = z.object({
  id: z.string(),
  detectedAt: z.string(),
  dialogText: z.string(),
  /** 仅匹配窗口的截图，经现有产物端点读取；无法截图时省略。 */
  screenshot: Artifact.optional(),
});

/**
 * 协议 3.7：电脑对一次失败的诊断（认出的常见原因），手机据此给出本地化的操作步骤；原话照旧在 error / lastMessage 里。
 * `kind` 与 `folder` 都是开集：任何字符串都透传（与 Swift / Kotlin 一致）；客户端不认得的 kind 当作没有诊断，不认得的 folder 当作 other。
 */
export const FailureDiagnosis = z.object({
  /** folderAccessDenied / agentNotInstalled / notSignedIn / signInExpired / usageLimit / projectMissing。 */
  kind: z.string(),
  /** 只随 folderAccessDenied：desktop / documents / downloads / iCloudDrive / removableVolume / networkVolume / other；系统拒绝访问（EPERM，macOS 上就是文件夹授权）时带；普通的目录权限问题（EACCES）省略。其他平台照样填，客户端只在 Mac 上用它。 */
  folder: z.string().optional(),
  /** 只随 usageLimit：额度恢复时间（秒精度 UTC），电脑读得到时才有。 */
  resetsAt: z.string().optional(),
});

/** 协议 2.6：新项目文件夹名的长度上限，与 Swift 的 `StartTask.maxNewProjectNameLength` 一致。 */
export const MAX_NEW_PROJECT_NAME = 80;
/** 协议 3.9：`startTask.newProjectParent` 的长度上限。 */
export const MAX_NEW_PROJECT_PARENT = 1024;

export const Task = z.object({
  id: z.string(),
  /** 所属电脑；任务的全局唯一键是 (agentId, id)。 */
  agentId: z.string(),
  source: TaskSource,
  title: z.string(),
  projectPath: z.string(),
  projectName: z.string(),
  status: TaskStatus,
  lastMessage: z.string().optional(),
  pendingRequest: PendingRequest.optional(),
  origin: TaskOrigin,
  controllable: z.boolean(),
  startedAt: z.string(),
  updatedAt: z.string(),
  /**
   * 协议 2.3：agent 回传的产物，**新的在前**；没有产物时整个键省略。由 Agent 的 TaskStore 附加，
   * 连接器与观察者不感知。旧 Relay 的 `z.object` 会把这个键剥掉，所以先部署 Relay 再发 Mac。
   */
  artifacts: z.array(Artifact).max(MAX_TASK_ARTIFACTS).optional(),
  /**
   * 协议 2.6：这条会话不在任何项目里（主目录、下载目录、临时目录或 Agent 的默认工作区）。
   * 只发 true 或省略，由 Agent 的 TaskStore 判定。旧 Relay 会剥掉这个键，所以先部署 Relay 再发 Mac。
   */
  outsideProject: z.boolean().optional(),
  /**
   * 协议 2.7：会话实际的工作目录，只在它是 git worktree 时出现，此时 `projectPath` 是主仓库。
   * 由 Agent 的 TaskStore 解析。旧 Relay 会剥掉这个键，所以先部署 Relay 再发 Mac。
   */
  worktreePath: z.string().optional(),
  /** 协议 2.10：系统授权弹窗历史证据，不是 pendingRequest。 */
  systemPermission: SystemPermissionNotice.optional(),
  /** 协议 2.13：ACP agent 的 id，只在 source = acp 时出现（且必须出现）。 */
  connectorId: AcpConnectorId.optional(),
  /** 协议 3.2：下一轮会用的模型与思考强度，电脑知道时才有。 */
  model: ModelId.optional(),
  effort: ModelEffort.optional(),
  /** 协议 3.3：所在项目开了自动批准；只写 true。 */
  autoApprove: z.boolean().optional(),
  /** 协议 3.7：电脑对这次失败的诊断，只在 status = failed 时出现。 */
  diagnosis: FailureDiagnosis.optional(),
})
  // 跨字段校验，不是字段本身的规则：`connectorId` 只跟 `source = acp` 一起出现。
  // `.extend()` / `.pick()` 出来的 schema 不带它，会把这条悄悄绕过去。
  .superRefine((t, ctx) => acpConnectorIdRule(t.source === "acp", t.connectorId, ctx));

/** 一条对话记录。`tool` 是工具调用的一行摘要（执行了什么命令、改了哪个文件）。 */
export const MessageRole = z.enum(["user", "agent", "tool"]);

/**
 * 协议 2.9：对话里的一张图（用户发的图 / Agent 生成的图），已经上传到 Relay。
 * 与 `startTask` / `followUp` 的 `attachments` 同形状。
 */
export const MessageAttachment = z.object({
  /** Agent 生成的 22 字符 base64url，与产物 id 同格式。 */
  artifactId: z.string().regex(ARTIFACT_ID_PATTERN),
  /** 如 `image/jpeg`。 */
  contentType: z.string().min(1).max(200),
  /** 上传后的字节数。 */
  size: z.number().int().nonnegative(),
  /** 像素，给客户端按比例占位。 */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * 协议 2.9：Agent 回复里提到的本机文件（图片 / 视频 / PDF），只出现在 `role = agent`。
 * `artifactId` 只在已经按需上传过（`fetchFile` 之后）才有。
 */
export const MessageFileRef = z.object({
  /** Mac 上的绝对路径，`fetchFile` 原样带回。 */
  path: z.string().min(1).max(1024),
  /** 显示用文件名。 */
  name: z.string().min(1).max(255),
  /** image/* | video/* | application/pdf。 */
  contentType: z.string().min(1).max(200),
  /** 原文件字节数。 */
  size: z.number().int().nonnegative(),
  artifactId: z.string().regex(ARTIFACT_ID_PATTERN).optional(),
});

/** 单条消息 `attachments` / `files` 各自的上限。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export const Message = z.object({
  /** 同一条消息重复拉取时必须稳定，客户端据此去重与做 diff。 */
  id: z.string(),
  role: MessageRole,
  /** 2.9 起可为空串：只要带了 attachments / files 就产出这条消息（图还在 Mac 上排队时会先不带、补发时带上）。 */
  text: z.string(),
  createdAt: z.string(),
  attachments: z.array(MessageAttachment).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  /** 只出现在 role = agent。 */
  files: z.array(MessageFileRef).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
});

/** 单条消息与单次拉取的上限。对话记录只随 `fetchMessages` 按需下发，不进常规快照。 */
export const MAX_MESSAGE_LENGTH = 1000;
/** 只数用户与 Agent 的消息；夹在中间的工具行另算，最多 `MAX_TOOL_MESSAGES` 条。 */
export const MAX_MESSAGES = 40;
export const MAX_TOOL_MESSAGES = 160;

/**
 * 一次 `fetchMessages` 的结果。`agentId` 由 Relay 按发来这一帧的连接盖章，负载里冒充别人不生效。
 * `hasMore` 表示更早的消息被截掉了。
 */
export const TaskMessages = z.object({
  taskId: z.string(),
  agentId: z.string(),
  messages: z.array(Message).max(MAX_MESSAGES + MAX_TOOL_MESSAGES),
  hasMore: z.boolean(),
  fetchedAt: z.string(),
});

// ---- Agent ----
/**
 * 协议规定接收方遇未知值必须拒绝整条，所以这里是闭集。2.5 起加入 hermes / pi / openclaw，
 * 2.13 起加入 acp（所有 ACP agent 共用，用 connectorId 区分），3.1 起加入 dsh（DeepSeek Harness，一档）。
 */
export const ConnectorKind = z.enum(["codex", "claude", "hermes", "pi", "openclaw", "acp", "dsh"]);
export const ConnectorStatus = z.enum(["ok", "degraded", "error"]);
/**
 * Agent 所在平台：`macos` / `linux` / `windows`（后两个 3.5 起）。开集：任何字符串都透传（不拒收整份快照），
 * 包括空串——与 Swift / Kotlin 一致，都解成「其他」，手机按「其他系统」显示。
 */
export const AgentPlatform = z.string();

/**
 * 协议 3.5：宿主能力。每个键都是可选布尔，缺省 = 支持（现在的 Mac 整个对象都不报；Linux 报
 * `remoteControl: false, previews: false`）。不认得的键忽略（zod 默认剥掉），以后加能力不用改 Relay。
 */
export const HostCapabilities = z.object({
  remoteControl: z.boolean().optional(),
  previews: z.boolean().optional(),
  fetchFile: z.boolean().optional(),
  fetchChanges: z.boolean().optional(),
});

/** 协议 3.2：手机上能选的一个模型；`defaultEffort` 必须是 `efforts` 里的一个。 */
export const ModelOption = z
  .object({
    id: ModelId,
    displayName: z.string(),
    efforts: z
      .array(ModelEffort)
      .min(1)
      .max(MAX_MODEL_EFFORTS)
      .refine((list) => new Set(list).size === list.length, { message: "efforts must be unique" })
      .optional(),
    defaultEffort: ModelEffort.optional(),
  })
  .refine((m) => m.defaultEffort === undefined || (m.efforts ?? []).includes(m.defaultEffort), {
    message: "defaultEffort must be one of efforts",
    path: ["defaultEffort"],
  });

/** 一台电脑上的一个 AI agent。 */
export const ConnectorInfo = z.object({
  kind: ConnectorKind,
  displayName: z.string(),
  available: z.boolean(),
  enabled: z.boolean(),
  status: ConnectorStatus,
  taskCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  /** 协议 2.13：ACP agent 的 id；kind = acp 时必填。 */
  connectorId: AcpConnectorId.optional(),
  /** 协议 2.14：能不能从手机新建任务；只写 false。 */
  canStartTask: z.boolean().optional(),
  /** 协议 3.2：续聊时能换的模型；省略 = 不能从手机换。 */
  models: z
    .array(ModelOption)
    .min(1)
    .max(MAX_MODELS)
    .refine((list) => new Set(list.map((m) => m.id)).size === list.length, { message: "models must be unique by id" })
    .optional(),
  /** 协议 3.3：能不能给项目开自动批准；只写 true。 */
  canAutoApprove: z.boolean().optional(),
  canDeleteTasks: z.boolean().optional(),
})
  // 跨字段校验，不是字段本身的规则：`connectorId` 只跟 `kind = acp` 一起出现。
  // `.extend()` / `.pick()` 出来的 schema 不带它，会把这条悄悄绕过去。
  .superRefine((c, ctx) => acpConnectorIdRule(c.kind === "acp", c.connectorId, ctx));

/** 协议规定的 connectors 上限（一档 6 个 + ACP 最多 10 个）；按 (kind, connectorId) 去重。 */
export const MAX_CONNECTORS = 16;

/**
 * 一台电脑。`connectors` 允许为空数组——刚被客户端认领、还没连上过的 Agent 报告的就是空的。
 * `online` 与 `lastSeenAt` 由 Relay 维护，Agent 上报时分别固定 true 与当前时间。
 */
export const AgentInfo = z.object({
  agentId: z.string(),
  name: z.string(),
  platform: AgentPlatform,
  online: z.boolean(),
  lastSeenAt: z.string(),
  appVersion: z.string(),
  connectors: z
    .array(ConnectorInfo)
    .max(MAX_CONNECTORS)
    .refine((list) => new Set(list.map((c) => `${c.kind}:${c.connectorId ?? ""}`)).size === list.length, {
      message: "connectors must be unique by (kind, connectorId)",
    }),
  /** 协议 2.6：手机新建项目时电脑在这个目录下建子文件夹；省略 = 这台电脑不接受新建项目。 */
  projectsRoot: z.string().optional(),
  /** 协议 3.4：能从手机开 worktree 会话、能 mergeWorktree。只写 true。 */
  worktrees: z.literal(true).optional(),
  /** 协议 3.5：宿主能力；省略 = 全部支持。 */
  capabilities: HostCapabilities.optional(),
  /** 协议 3.7：电脑提供「操作电脑」的工作区服务（文件与终端）。只写 true。 */
  workspace: z.literal(true).optional(),
  canRemoveProjects: z.boolean().optional(),
  /** 协议 3.9：能从手机重启 Agent（restartConnector）。只写 true。 */
  canRestartConnectors: z.literal(true).optional(),
  /** 协议 3.9：新建项目能指定父目录（startTask.newProjectParent）。只写 true。 */
  canChooseProjectParent: z.literal(true).optional(),
});

// ---- Snapshot ----
export const Project = z.object({
  /** 项目路径只在其所属电脑上有意义。 */
  agentId: z.string(),
  path: z.string(),
  name: z.string(),
  lastUsedAt: z.string(),
  pinned: z.boolean(),
  /** 协议 3.3：这个项目开了自动批准；只写 true。 */
  autoApprove: z.boolean().optional(),
});

export const CommandResult = z.object({
  commandId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  taskId: z.string().optional(),
  finishedAt: z.string(),
  /** 协议 2.10：任务尚未创建时也可随失败结果返回。 */
  systemPermission: SystemPermissionNotice.optional(),
  /** 协议 2.11：`fetchChanges` 成功时，改动清单（WorkingChanges JSON）的产物 id。 */
  artifactId: z.string().min(1).optional(),
  /** 协议 3.7：电脑对这次失败的诊断；任务尚未创建时也可随失败结果返回。 */
  diagnosis: FailureDiagnosis.optional(),
});

/**
 * Agent 发出时 `agents` 恰好一个元素（自己），`recentResults` 为 `[]`、`seq` 为 0；
 * 客户端取到的是 Relay 把各 Agent 分片合并后的结果。
 */
export const Snapshot = z.object({
  agents: z.array(AgentInfo),
  tasks: z.array(Task),
  projects: z.array(Project),
  recentResults: z.array(CommandResult),
  /**
   * 最近一次 `fetchMessages` 的结果，最多一份，且只在 Relay 里留 5 分钟。
   * 对话记录太大，不能常驻快照——客户端收到后应自己缓存，不要指望它一直在。
   */
  /**
   * 缺省当空数组：**不能因为对端版本旧就整条快照解不出来**。
   * Agent 与客户端各自独立升级，中间必然有一段两边版本不一致的窗口，
   * 那段时间里丢掉的应该只是这一个字段，而不是整台电脑的任务。
   */
  recentMessages: z.array(TaskMessages).max(1).default([]),
  seq: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

// ---- WorkingChanges ----
/**
 * 协议 2.11：`fetchChanges` 的结果——任务目录里还没提交的改动。Relay 不解析它：Mac 把它编码成 JSON
 * 当普通产物上传，手机按产物取字节。这里的 schema 只为让 Swift 与 TypeScript 两边的定义同源、fixture 同一套。
 */
export const ChangedFile = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted"]),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  binary: z.boolean().optional(),
  patch: z.string().optional(),
  truncated: z.boolean().optional(),
});

export const WorkingChanges = z.object({
  directory: z.string(),
  branch: z.string().optional(),
  generatedAt: z.string(),
  files: z.array(ChangedFile),
  totalFiles: z.number().int().nonnegative(),
  /** 协议 3.4：可以把这些改动合并回去的分支；只有 BotBus 开的 worktree 会话才有。 */
  mergeTarget: z.string().optional(),
});

// ---- Command ----
/**
 * 协议 2.9 起加入 fetchFile，2.11 起加入 fetchChanges，2.12 起加入 remoteControl，3.4 起加入 mergeWorktree，
 * 3.8 起加入 deleteTask / removeProject，3.9 起加入 restartConnector。
 */
export const CommandKind = z.enum([
  "startTask", "followUp", "approve", "interrupt", "setConnectorEnabled", "fetchMessages", "fetchFile",
  "fetchChanges", "remoteControl", "mergeWorktree", "deleteTask", "removeProject", "restartConnector",
]);

export const Command = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    /** 目标电脑，Relay 据此路由。 */
    agentId: z.string(),
    kind: CommandKind,
    /**
     * projectPath 为空串（2.6 起）= 不在项目中，由电脑选目录。newProject（2.6）是新项目的文件夹名，
     * 电脑在 AgentInfo.projectsRoot 下建它；名字合不合法由电脑判定，这里只卡长度。
     * attachments（2.9 起）是手机发的图；带附件时 prompt 可为空串。
     */
    startTask: z
      .object({
        source: TaskSource,
        projectPath: z.string(),
        prompt: z.string(),
        newProject: z.string().min(1).max(MAX_NEW_PROJECT_NAME).optional(),
        attachments: z.array(MessageAttachment).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
        /** 协议 2.13：发给哪个 ACP agent，`source = acp` 时必填。 */
        connectorId: AcpConnectorId.optional(),
        /** 协议 3.2：这条会话的模型与思考强度，之后的续聊沿用；省略 = agent 默认。 */
        model: ModelId.optional(),
        effort: ModelEffort.optional(),
        /** 协议 3.3：把所在项目的自动批准设为开 / 关，之后沿用；省略 = 不动。 */
        autoApprove: z.boolean().optional(),
        /** 协议 3.4：在项目仓库新开的 git worktree 里跑。只和非空 projectPath 一起出现，不配 newProject，openclaw 不收。 */
        worktree: z.literal(true).optional(),
        /** 协议 3.9：新项目文件夹建在哪个目录下（电脑上的绝对路径），只和 newProject 一起出现。 */
        newProjectParent: z.string().min(1).max(MAX_NEW_PROJECT_PARENT).optional(),
      })
      .superRefine((s, ctx) => {
        acpConnectorIdRule(s.source === "acp", s.connectorId, ctx);
        if (s.newProjectParent !== undefined && s.newProject === undefined) {
          ctx.addIssue({ code: "custom", path: ["newProjectParent"], message: "newProjectParent needs newProject" });
        }
        if (s.worktree && (s.newProject !== undefined || s.source === "openclaw" || s.projectPath.trim() === "")) {
          ctx.addIssue({ code: "custom", path: ["worktree"],
            message: "worktree needs a non-empty projectPath, no newProject, and a source other than openclaw" });
        }
      })
      .optional(),
    /**
     * model / effort（3.2 起）：从这一轮起换模型与思考强度，之后的续聊沿用；省略 = 不换。
     * autoApprove（3.3 起）：把所在项目的自动批准设为开 / 关，之后沿用；省略 = 不动。
     */
    followUp: z.object({
      taskId: z.string(),
      prompt: z.string(),
      attachments: z.array(MessageAttachment).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
      model: ModelId.optional(),
      effort: ModelEffort.optional(),
      autoApprove: z.boolean().optional(),
    }).optional(),
    /** answers（2.14 起）：回答 PendingRequest.questions，键是问题 id，值是选中的 label 或自己打的字。 */
    approve: z
      .object({
        taskId: z.string(),
        requestId: z.string(),
        decision: z.enum(["allow", "deny"]),
        answers: z.record(z.string(), z.array(z.string()).max(MAX_QUESTION_OPTIONS)).optional(),
      })
      .optional(),
    interrupt: z.object({ taskId: z.string() }).optional(),
    setConnectorEnabled: z
      .object({ connector: ConnectorKind, connectorId: AcpConnectorId.optional(), enabled: z.boolean() })
      .superRefine((s, ctx) => acpConnectorIdRule(s.connector === "acp", s.connectorId, ctx))
      .optional(),
    fetchMessages: z.object({ taskId: z.string(), limit: z.number().int().positive().max(MAX_MESSAGES).optional() }).optional(),
    /** 协议 2.9：手机点一下按需取回 Agent 提到的本机文件。 */
    fetchFile: z.object({
      taskId: z.string().min(1),
      messageId: z.string().min(1),
      path: z.string().min(1).max(1024),
    }).optional(),
    /** 协议 2.11：看任务目录里还没提交的改动，结果以产物上传。 */
    fetchChanges: z.object({ taskId: z.string().min(1) }).optional(),
    /**
     * 协议 2.12：远程操作电脑桌面。电脑起本机的远程操作服务并分享成预览，预览产物 id 随
     * CommandResult.artifactId 回来。Relay 只转发，不碰服务本身——画面和输入都走既有的预览隧道。
     */
    remoteControl: z.object({ enabled: z.boolean() }).optional(),
    /** 协议 3.4：把 BotBus 开的 worktree 会话 squash 合并回检出分支，删 worktree 与分支，隐藏会话。 */
    mergeWorktree: z.object({ taskId: z.string().min(1) }).optional(),
    deleteTask: z.object({ taskId: z.string().min(1) }).optional(),
    removeProject: z.object({ projectPath: z.string().min(1) }).optional(),
    /** 协议 3.9：在电脑上重启一个 Agent（先停用、等收尾，再启用）。 */
    restartConnector: z
      .object({ connector: ConnectorKind, connectorId: AcpConnectorId.optional() })
      .superRefine((s, ctx) => acpConnectorIdRule(s.connector === "acp", s.connectorId, ctx))
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c[c.kind] === undefined) {
      ctx.addIssue({ code: "custom", path: [c.kind], message: `payload for kind ${c.kind} is missing` });
    }
  });

// ---- Event ----
export const Notify = z
  .object({
    taskId: z.string(),
    category: z.enum(["TASK_APPROVAL", "TASK_INPUT", "TASK_DONE", "TASK_FAILED"]),
    title: z.string(),
    body: z.string(),
    requestId: z.string().optional(),
    /** 协议 3.0：发通知的电脑名。整条 Notify 在密文里，由 Mac 自己填，给 iPhone 的通知扩展显示。 */
    agentName: z.string().optional(),
  })
  .superRefine((n, ctx) => {
    if (n.category === "TASK_APPROVAL" && n.requestId === undefined) {
      ctx.addIssue({ code: "custom", path: ["requestId"], message: "requestId is required for TASK_APPROVAL" });
    }
  });

/** 每种 Event kind 必须携带的配套字段。 */
const eventPayloadKey = {
  snapshot: "snapshot",
  taskUpdated: "task",
  taskRemoved: "taskId",
  commandResult: "commandResult",
  notify: "notify",
  taskMessages: "taskMessages",
} as const;

export const Event = z
  .object({
    kind: z.enum(["snapshot", "taskUpdated", "taskRemoved", "commandResult", "notify", "taskMessages"]),
    snapshot: Snapshot.optional(),
    task: Task.optional(),
    taskId: z.string().optional(),
    commandResult: CommandResult.optional(),
    notify: Notify.optional(),
    taskMessages: TaskMessages.optional(),
  })
  .superRefine((e, ctx) => {
    const key = eventPayloadKey[e.kind];
    if (e[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: `payload for kind ${e.kind} is missing` });
    }
  });

// ---- 协议 3.0：端到端加密的线上形状 ----
//
// 上面的明文 schema（Task、Snapshot、Command、Event……）描述的是**密文里面**的内容：Relay 运行时不再解析它们，
// 只留着让 `protocol-fixtures/plain/` 的样本在 TypeScript 这边也有一份同源定义（Swift、Android、Windows 同理）。
// Relay 真正收发、存储的是下面这些密封形状：只有路由、合并、截断用得到的字段是明文，其余整个领域对象在 `sealed` 里。
// 格式见 `docs/superpowers/specs/2026-09-26-end-to-end-encryption-design.md` 与 `PROTOCOL.md`「端到端加密」。

/** `0x01 ‖ nonce(12) ‖ AES-256-GCM 密文 ‖ tag(16)` 的无填充 base64url；至少 29 字节，即 39 个字符。 */
export const Sealed = z.string().regex(/^[A-Za-z0-9_-]{39,}$/, "not a sealed envelope");

/** 一台电脑。`sealed`（完整 AgentInfo）缺省 = 刚被认领、还没连上过。`online` / `lastSeenAt` 由 Relay 维护。 */
export const SealedAgent = z.object({
  agentId: z.string(),
  online: z.boolean(),
  lastSeenAt: z.string(),
  sealed: Sealed.optional(),
});

/** 一条任务。Relay 按 `id` 合并、按 `updatedAt` 排序与截断。 */
export const SealedTask = z.object({
  id: z.string(),
  agentId: z.string(),
  updatedAt: z.string(),
  sealed: Sealed,
});

/** 一台电脑的整个项目列表（`[Project]`），只随 snapshot 事件整体替换。Relay 不再截断项目。 */
export const SealedProjects = z.object({ agentId: z.string(), sealed: Sealed });

/** 一次 fetchMessages 的结果（完整 TaskMessages）。 */
export const SealedMessages = z.object({
  taskId: z.string(),
  agentId: z.string(),
  fetchedAt: z.string(),
  sealed: Sealed,
});

/**
 * 命令结果。Mac 发的带 `sealed`；Relay 自己造的（离线队列过期）没有密钥，只能是明文 `error`。两者恰好一个。
 */
export const SealedResult = z
  .object({
    commandId: z.string(),
    finishedAt: z.string(),
    sealed: Sealed.optional(),
    error: z.string().optional(),
  })
  .refine((r) => (r.sealed === undefined) !== (r.error === undefined), {
    message: "exactly one of sealed / error",
  });

/** 推送：`category` / `requestId` / `taskId` 留明文（APNs 载荷要用），标题正文用 `K_notify` 密封。 */
export const SealedNotify = z
  .object({
    taskId: z.string(),
    agentId: z.string(),
    category: z.enum(["TASK_APPROVAL", "TASK_INPUT", "TASK_DONE", "TASK_FAILED"]),
    requestId: z.string().optional(),
    sealed: Sealed,
  })
  .superRefine((n, ctx) => {
    if (n.category === "TASK_APPROVAL" && n.requestId === undefined) {
      ctx.addIssue({ code: "custom", path: ["requestId"], message: "requestId is required for TASK_APPROVAL" });
    }
  });

export const SealedSnapshot = z.object({
  agents: z.array(SealedAgent),
  tasks: z.array(SealedTask),
  projects: z.array(SealedProjects),
  recentResults: z.array(SealedResult),
  recentMessages: z.array(SealedMessages).max(1),
  seq: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

/** 命令：Relay 只看目标电脑与 id；`kind` 与载荷都在密文里。 */
export const SealedCommand = z.object({
  id: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
  sealed: Sealed,
});

export const SealedEvent = z
  .object({
    kind: z.enum(["snapshot", "taskUpdated", "taskRemoved", "commandResult", "notify", "taskMessages"]),
    snapshot: SealedSnapshot.optional(),
    task: SealedTask.optional(),
    taskId: z.string().optional(),
    commandResult: SealedResult.optional(),
    notify: SealedNotify.optional(),
    taskMessages: SealedMessages.optional(),
  })
  .superRefine((e, ctx) => {
    const key = eventPayloadKey[e.kind];
    if (e[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: `payload for kind ${e.kind} is missing` });
    }
  });

/**
 * 手机封给一台 Mac 的组密钥：`epk` 是手机的临时 X25519 公钥，`sealed` 用 ECDH + HKDF 得到的包裹键密封 K。
 * Relay 存进 agents 表、在 hello 帧里转交，自己解不开（Mac 的公钥只在二维码里，没经过 Relay）。
 */
export const KeyEnvelope = z.object({
  epk: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "not an X25519 public key"),
  sealed: Sealed,
});

// ---- WebSocket frames ----
export const AgentFrame = z.object({ type: z.literal("event"), event: SealedEvent });
/**
 * 协议版本号的写法：两到三段点分整数（`3.5`、`3.10`、`4.0.1`），每段 1–4 位数字。
 * 与 Swift 的 `ProtocolVersion.isWellFormed` 一致。
 */
export const ProtocolVersionString = z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,4}){1,2}$/, "not a protocol version");
/**
 * 协议 3.0：Agent 连上后的第一帧，用来标就绪、换 hello。
 * 3.6 起可带 `minClientProtocol`：这台电脑要求手机至少是这个版本（Linux 宿主报 3.5——更早的手机见到
 * `platform: "linux"` 会拒收整份快照）。它在信封外面，是 Relay 按组给旧手机回 412 用的路由元数据；
 * 省略 = 不要求（Mac）。写法不对的整帧不认。
 */
export const AgentReadyFrame = z.object({ type: z.literal("ready"), minClientProtocol: ProtocolVersionString.optional() });
export const AgentAckFrame = z.object({ type: z.literal("ack"), commandIds: z.array(z.string()) });
export const RelayFrame = z.object({ type: z.literal("command"), command: SealedCommand });
/**
 * 每次连上后 Relay 告诉 Agent 它属于哪个组；Agent 下次连接带 `X-Pair-Hint`，跳过全局 Directory。
 * 3.0 起带上手机封给这台电脑的组密钥（有就带）。
 */
export const RelayHelloFrame = z.object({ type: z.literal("hello"), pairId: z.string(), keyEnvelope: KeyEnvelope.optional() });
/**
 * Relay → 客户端（`GET /client/ws`）：`snapshot` 带全量快照；`changed` 只报新 seq，
 * 表示这份快照太大不走 WebSocket，客户端改用 `GET /client/snapshot?since=-1` 取。
 */
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: SealedSnapshot }),
  z.object({ type: z.literal("changed"), seq: z.number().int() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---- Relay HTTP messages ----
/** POST /agent/register：只登记，等客户端认领，此时还没有 pairId。 */
export const AgentRegisterResponse = z.object({
  agentId: z.string(),
  agentToken: z.string(),
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.string(),
});
/**
 * POST /pair/claim 与 POST /pair/agents 的请求体。`sealedName` 是手机名的密文（只有认领时有意义）。
 * `keyEnvelope`：用注册码认领（新组）与 `/pair/agents` 必填；用邀请码认领时省略（K 在二维码里）。
 */
export const PairClaimRequest = z.object({
  code: z.string().regex(/^\d{6}$/),
  sealedName: Sealed.optional(),
  keyEnvelope: KeyEnvelope.optional(),
});
/**
 * POST /pair/claim 的响应。`agents` 是这台手机现在能看到的全部电脑：
 * 用注册码建组时只有刚认领的那一台，用邀请码加入已有组时是组里的全部。
 */
export const PairClaimResponse = z.object({
  pairId: z.string(),
  clientToken: z.string(),
  agents: z.array(SealedAgent),
});
/** POST /pair/agents：把第二台电脑加入已有 Pair。 */
export const PairAgentsResponse = z.object({ agent: SealedAgent });
/** POST /agent/invite：电脑替本组印一个手机邀请码，供第二台手机扫。 */
export const AgentInviteResponse = z.object({
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.string(),
});
/** 组内一台手机的安全视图。`clientToken` 只有它自己有，这里一个字节都不带。 */
export const PairedClient = z.object({
  id: z.string(),
  /** 手机名的密文；协议 v2 时代的记录没有名字，此时省略。 */
  sealedName: Sealed.optional(),
  addedAt: z.string(),
  /** 是不是发起这次请求的那一台。踢自己下线要额外确认，界面靠它区分。 */
  current: z.boolean(),
});
/** GET /pair/clients：本组的手机列表。 */
export const PairClientsResponse = z.object({ clients: z.array(PairedClient) });
/**
 * GET /agent/devices：不含任何 token 的安全视图。
 * `devices` 是推送注册（手机与手表各一条，带最后活跃时间）；`clients`（2.15）是本组的手机凭据，
 * 电脑拿它的 `id` 调 `DELETE /pair/clients/:id` 移除一台手机。`devices[].clientId`（2.15）标出
 * 这条推送注册属于哪台手机——手表沿用配它的那台手机的凭据，所以和那台手机是同一个 `clientId`；
 * 2.15 之前注册、还没重新上报过的设备没有它。
 */
export const AgentDevicesResponse = z.object({
  devices: z.array(
    z.object({
      sealedName: Sealed,
      platform: z.enum(["ios", "watchos", "android"]),
      lastSeenAt: z.string(),
      clientId: z.string().optional(),
    }),
  ),
  clients: z.array(
    z.object({
      id: z.string(),
      sealedName: Sealed.optional(),
      addedAt: z.string(),
    }),
  ),
});
/**
 * 设备名的密文上限（3.0）。名字由客户端截到 40 字再封，40 个四字节字符的 JSON 串封好也不到 300 字符；
 * Relay 读不到明文、截不了，只能按密文长度挡住超长的。
 */
export const MAX_SEALED_DEVICE_NAME_LENGTH = 512;
const SealedDeviceName = Sealed.max(MAX_SEALED_DEVICE_NAME_LENGTH);

/**
 * `POST /client/devices` 的请求体。`lastSeenAt` **不在其中**：它由 Relay 在每次注册时按当前时间写入
 * （客户端每轮长轮询重新注册一次，这就是它的活跃心跳），只出现在 `GET /agent/devices` 的响应里。
 * zod 默认丢弃未知键，因此客户端就算报了 `lastSeenAt` 也不会被采纳。
 */
export const DeviceRegistration = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ios", "watchos", "android"]),
  environment: z.enum(["sandbox", "production"]),
  sealedName: SealedDeviceName,
});

/**
 * Relay 存储里的一台设备：注册体 + Relay 维护的 `lastSeenAt` 与 `clientId`（2.15，注册它的那份手机凭据）。
 * `token` 只在 Relay 内部使用。2.15 之前存下的设备没有 `clientId`，下一次重新注册（每轮长轮询一次）时补上。
 */
export type StoredDevice = z.infer<typeof DeviceRegistration> & { lastSeenAt: string; clientId?: string };
export const CommandAccepted = z.object({ commandId: z.string(), delivered: z.boolean() });

/** PUT /agent/artifacts/:artifactId：Relay 存下的产物字节数与到期时间。 */
export const ArtifactUploadResponse = z.object({
  id: z.string().regex(ARTIFACT_ID_PATTERN),
  size: z.number().int(),
  expiresAt: z.string(),
});
/** POST /agent/previews 的请求体。 */
export const PreviewCreateRequest = z.object({ title: z.string().optional() });
/** POST /agent/previews：预览主机为 `p-<previewId>.<PREVIEW_DOMAIN>`。 */
export const PreviewCreateResponse = z.object({
  previewId: z.string().regex(PREVIEW_ID_PATTERN),
  expiresAt: z.string(),
});
/**
 * POST /client/previews/:previewId/session。`url` 是带一次性 ticket 的完整预览入口
 * （`https://p-<id>.<PREVIEW_DOMAIN>/__botbus/auth?ticket=…`），`expiresAt` 是这个 ticket 的
 * 失效时间（签发后 60 秒）——url 只能打开一次，每次打开都要重新取。
 */
export const PreviewSessionResponse = z.object({ url: z.string(), expiresAt: z.string() });

export type Task = z.infer<typeof Task>;
export type SealedAgent = z.infer<typeof SealedAgent>;
export type SealedTask = z.infer<typeof SealedTask>;
export type SealedProjects = z.infer<typeof SealedProjects>;
export type SealedMessages = z.infer<typeof SealedMessages>;
export type SealedResult = z.infer<typeof SealedResult>;
export type SealedNotify = z.infer<typeof SealedNotify>;
export type SealedSnapshot = z.infer<typeof SealedSnapshot>;
export type SealedCommand = z.infer<typeof SealedCommand>;
export type SealedEvent = z.infer<typeof SealedEvent>;
export type KeyEnvelope = z.infer<typeof KeyEnvelope>;
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export type Artifact = z.infer<typeof Artifact>;
export type SystemPermissionNotice = z.infer<typeof SystemPermissionNotice>;
export type FailureDiagnosis = z.infer<typeof FailureDiagnosis>;
export type ArtifactUploadResponse = z.infer<typeof ArtifactUploadResponse>;
export type PreviewCreateRequest = z.infer<typeof PreviewCreateRequest>;
export type PreviewCreateResponse = z.infer<typeof PreviewCreateResponse>;
export type PreviewSessionResponse = z.infer<typeof PreviewSessionResponse>;
export type PendingRequest = z.infer<typeof PendingRequest>;
export type Project = z.infer<typeof Project>;
export type ConnectorKind = z.infer<typeof ConnectorKind>;
export type ConnectorInfo = z.infer<typeof ConnectorInfo>;
export type AgentInfo = z.infer<typeof AgentInfo>;
export type HostCapabilities = z.infer<typeof HostCapabilities>;
export type Snapshot = z.infer<typeof Snapshot>;
export type CommandResult = z.infer<typeof CommandResult>;
export type Command = z.infer<typeof Command>;
export type Event = z.infer<typeof Event>;
export type Notify = z.infer<typeof Notify>;
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;
export type AgentDevicesResponse = z.infer<typeof AgentDevicesResponse>;
export type Message = z.infer<typeof Message>;
export type MessageAttachment = z.infer<typeof MessageAttachment>;
export type MessageFileRef = z.infer<typeof MessageFileRef>;
export type TaskMessages = z.infer<typeof TaskMessages>;
export type WorkingChanges = z.infer<typeof WorkingChanges>;
export type PairedClient = z.infer<typeof PairedClient>;
export type PairClientsResponse = z.infer<typeof PairClientsResponse>;
