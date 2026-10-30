/**
 * 项目路径归一化：连接器设置（协议 3.3）与移出项目（协议 3.8）共用。
 *
 * 放在 `bus/` 而不是 `connectors/`，这样 `bus` 不需要反向依赖 `connectors`。
 * 行为与原来的 `connectors/settings-store.ts` 完全一致：trim、反斜杠→斜杠、
 * 去掉尾部分隔符，Windows 上转小写（NTFS 默认不区分大小写）。
 */
export function normalizeProjectPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
