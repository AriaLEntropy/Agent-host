# Agent-host

电脑端程序。手机只认 BotBus 协议 3.9，经现有 sealed-tunnel-v1 隧道访问本机的 `/bus`。

选型按需求 2.7 的方案 B：语言 Node.js / TypeScript，首期桌面平台 Windows。隧道代码复用 dsh-scan-remote（见 `NOTICE`，提交 `ba18aaf`）。协议形状对照 botbus-protocol（提交 `9389165`）的 `src/protocol.ts`。

## 数据目录

Windows 是 `%APPDATA%\agent-host`。可用 `AGENT_HOST_CONFIG` 指向另一份 `config.json`。不读写 `~/.botbus/`。

设备凭据（`hostToken`、`e2eeMasterKey`）目前写在这份配置文件里，写入时权限按 `0600`。Windows 凭据管理器还没有接上。这是 FR-14.3.2 允许的文件兜底，等凭据库定了再换。

## 命令

```bash
npm install
npm test
npx tsx src/cli.ts pair
npx tsx src/cli.ts up
npx tsx src/cli.ts unpair
```

`pair` 在终端打印二维码。`up` 未配对时先配对，然后连上 Relay。默认 Relay 是 `https://relay.dshmobile.online`，可用 `AGENT_HOST_RELAY` 覆盖。写进二维码的地址用 `PUBLIC_RELAY_URL`。

## 还没做

托盘和设置窗口是 M2。ACP 与 DSH 已能用本机进程驱动；没装 `dsh` 时该连接器 `available` 为 false。手机上的协议同步在手机工程里，真机扫码还不在这一步。
