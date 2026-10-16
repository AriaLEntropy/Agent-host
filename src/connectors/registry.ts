export type RegistryEntry = {
  id: string;
  name: string;
  binaries: string[];
  args: string[];
  npmPackage?: string;
};

/** Copied from botbus-protocol AcpRegistrySnapshot.swift. Adapters are not filtered out. */
export const registryEntries: RegistryEntry[] = [
  { id: "agoragentic-acp", name: "Agoragentic", binaries: ["agoragentic-mcp"], args: ["--acp"], npmPackage: "agoragentic-mcp" },
  { id: "amp-acp", name: "Amp", binaries: ["amp-acp"], args: [] },
  { id: "antigravity-acp", name: "Google Antigravity", binaries: ["agy_acp_server.par"], args: [] },
  { id: "auggie", name: "Auggie CLI", binaries: ["auggie"], args: ["--acp"], npmPackage: "@augmentcode/auggie" },
  { id: "autohand", name: "Autohand Code", binaries: ["autohand-acp"], args: [], npmPackage: "@autohandai/autohand-acp" },
  { id: "cline", name: "Cline", binaries: ["cline"], args: ["--acp"], npmPackage: "cline" },
  { id: "codebuddy-code", name: "Codebuddy Code", binaries: ["codebuddy-code", "cbc"], args: ["--acp"], npmPackage: "@tencent-ai/codebuddy-code" },
  { id: "cortex-code", name: "Cortex Code", binaries: ["cortex"], args: ["acp", "serve"] },
  { id: "corust-agent", name: "Corust Agent", binaries: ["corust-agent-acp"], args: [] },
  { id: "crow-cli", name: "crow-cli", binaries: ["crow-cli"], args: ["acp"] },
  { id: "cursor", name: "Cursor", binaries: ["cursor-agent"], args: ["acp"] },
  { id: "deepagents", name: "DeepAgents", binaries: ["deepagents-acp"], args: [], npmPackage: "deepagents-acp" },
  { id: "devin", name: "Devin", binaries: ["devin"], args: ["acp"] },
  { id: "dimcode", name: "DimCode", binaries: ["dimcode", "dim"], args: ["acp"], npmPackage: "dimcode" },
  { id: "dirac", name: "Dirac", binaries: ["dirac"], args: ["--acp"], npmPackage: "dirac-cli" },
  { id: "factory-droid", name: "Factory Droid", binaries: ["droid"], args: ["exec", "--output-format", "acp-daemon"], npmPackage: "droid" },
  { id: "fast-agent", name: "fast-agent", binaries: ["fast-agent-acp"], args: ["-x"] },
  { id: "gemini", name: "Gemini CLI", binaries: ["gemini"], args: ["--acp"], npmPackage: "@google/gemini-cli" },
  { id: "github-copilot-cli", name: "GitHub Copilot", binaries: ["copilot"], args: ["--acp"], npmPackage: "@github/copilot" },
  { id: "glm-acp-agent", name: "GLM Agent", binaries: ["glm-acp-agent"], args: [], npmPackage: "glm-acp-agent" },
  { id: "goose", name: "goose", binaries: ["goose"], args: ["acp"] },
  { id: "grok-build", name: "Grok Build", binaries: ["grok"], args: ["agent", "stdio"], npmPackage: "@xai-official/grok" },
  { id: "harn", name: "Harn", binaries: ["harn"], args: ["serve", "acp"] },
  { id: "junie", name: "Junie", binaries: ["junie"], args: ["--acp=true"] },
  { id: "kilo", name: "Kilo", binaries: ["kilo"], args: ["acp"] },
  { id: "kimchi", name: "Kimchi", binaries: ["kimchi"], args: ["--mode", "acp"] },
  { id: "kimi", name: "Kimi CLI", binaries: ["kimi"], args: ["acp"] },
  { id: "minimax-code", name: "MiniMax Code", binaries: ["mcode"], args: ["acp"], npmPackage: "@minimax-ai/code" },
  { id: "minion-code", name: "Minion Code", binaries: ["minion-code"], args: ["acp"] },
  { id: "mistral-vibe", name: "Mistral Vibe", binaries: ["vibe-acp"], args: [] },
  { id: "nova", name: "Nova", binaries: ["nova", "compass"], args: ["acp"], npmPackage: "@compass-ai/nova" },
  { id: "opencode", name: "OpenCode", binaries: ["opencode"], args: ["acp"] },
  { id: "poolside", name: "Poolside", binaries: ["pool-darwin-arm64"], args: ["acp"] },
  { id: "qoder", name: "Qoder CLI", binaries: ["qoder", "qodercli"], args: ["--acp"], npmPackage: "@qoder-ai/qodercli" },
  { id: "qwen-code", name: "Qwen Code", binaries: ["qwen"], args: ["--acp", "--experimental-skills"], npmPackage: "@qwen-code/qwen-code" },
  { id: "sigit", name: "siGit Code", binaries: ["sigit"], args: [] },
  { id: "stakpak", name: "Stakpak", binaries: ["stakpak"], args: ["acp"] },
  { id: "vtcode", name: "VT Code", binaries: ["vtcode"], args: ["acp"] },
];
