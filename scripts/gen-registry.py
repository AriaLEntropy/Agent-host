import re
from pathlib import Path

src = Path(r"e:\projects\AgentBus\botbus-protocol\Sources\BotBusConnectors\Acp\AcpRegistrySnapshot.swift").read_text(encoding="utf-8")
pat = re.compile(
    r'AcpRegistryEntry\(id: "([^"]+)", name: "([^"]+)", binaries: \[(.*?)\], args: \[(.*?)\], defaultEnabled: true(?:, npmPackage: "([^"]+)")?'
)

def quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

lines = [
    "export type RegistryEntry = {",
    "  id: string;",
    "  name: string;",
    "  binaries: string[];",
    "  args: string[];",
    "  npmPackage?: string;",
    "};",
    "",
    "/** Copied from botbus-protocol AcpRegistrySnapshot.swift. Adapters are not filtered out. */",
    "export const registryEntries: RegistryEntry[] = [",
]
count = 0
for match in pat.finditer(src):
    binaries = re.findall(r'"([^"]+)"', match.group(3))
    args = re.findall(r'"([^"]+)"', match.group(4))
    npm = match.group(5)
    binary_list = ", ".join(quote(item) for item in binaries)
    arg_list = ", ".join(quote(item) for item in args)
    npm_field = f", npmPackage: {quote(npm)}" if npm else ""
    lines.append(
        "  { id: %s, name: %s, binaries: [%s], args: [%s]%s },"
        % (quote(match.group(1)), quote(match.group(2)), binary_list, arg_list, npm_field)
    )
    count += 1
lines.append("];")
out = Path(r"e:\projects\AgentBus\Agent-host\src\connectors\registry.ts")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"{count} entries")
