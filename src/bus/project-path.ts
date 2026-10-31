/**
 * 项目路径归一化：连接器设置（协议 3.3）与移出项目（协议 3.8）共用。
 *
 * 放在 `bus/` 而不是 `connectors/`，这样 `bus` 不需要反向依赖 `connectors`。
 * 平台差异（分隔符、大小写、根目录）统一交给 `platform/path.ts`，与移植的
 * `PlatformPath` 共用一套规则；这里只保留协议面的身份写法：trim、反斜杠→斜杠、
 * 去掉尾部分隔符，Windows 上转小写（NTFS 默认不区分大小写）。
 */
import { platformPath } from "../platform/path.js";

export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  let value = platformPath.normalized(trimmed);
  if (platformPath.isAbsolute(value)) value = platformPath.canonical(value);
  if (platformPath.platform === "win32") value = value.toLowerCase();
  // 手机与协议都按 `C:/Users/...` 这种形状存，保持既有快照/设置格式不变。
  return value.replace(/\\/g, "/");
}
