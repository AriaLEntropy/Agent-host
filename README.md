# Agent-host

把电脑上的编码 Agent（DSH、ACP 兼容 Agent）接到手机上的桌面端程序。手机扫码配对后，通过端到端加密隧道访问本机的 Bus Host API；电脑不需要公网地址，程序也不额外监听 TCP 端口。

> 状态：早期开发版。

## 功能

- 手机扫码配对，凭据只保存在本机。
- 复用 sealed-tunnel-v1：手机和电脑之间是加密隧道，Relay 只转发密文。
- 提供 `/bus/describe`、`/bus/snapshot`、`/bus/ws`、`/bus/commands` 等 Bus Host API。
- 命令分发到本机 ACP / DSH Agent：新建、续聊、审批、中断、取对话。
- 把隧道里的其他请求转发给本机 DSH web（默认 `127.0.0.1:3080`）。
- 断线指数退避重连。

## 环境要求

- Windows 10/11（首期；其他桌面平台后续支持）
- Node.js 18+
- 手机安装支持 Agent-host 的 App（会请求 `/bus/describe`）
- 可选：本机 DSH 在 `3080` 运行（需要 DSH 完整视图时）

## 快速开始

### 安装

```bash
npm install
npm run build
```

### 配对并启动

```bash
npm start -- up
```

第一次运行会在终端打印二维码，并停在等待扫码。

1. 手机 App 打开「连接设置」→「扫码连接」→「扫描电脑二维码」。
2. 不要用浏览器打开二维码里的链接。
3. 终端出现 `Paired as ... at ...` 并保持运行，表示配对成功。

之后再启动只需要 `npm start -- up`，不用重新扫码。

### 停止和撤销

- `Ctrl+C` 停止。
- `npm start -- unpair` 撤销这台电脑的配对；手机在一次重连内回到未配对。

## 本机 Relay（手机和电脑同一 WiFi）

当前版本的配对接口以本仓库的 `dsh-scan-remote/relay` 为准。公共 `https://relay.dshmobile.online` 是另一个 fork/部署，配对接口与本地不一致（实测 `/pair/confirm` 返回 401），联调时请使用本机 Relay 或与你代码同版本的 Relay。

同一 WiFi 自测时：

1. 在 `dsh-scan-remote/relay` 启动 Relay：

```bash
npm run build
HOST=0.0.0.0 PORT=8787 DATABASE_PATH=./data/relay.sqlite npm start
```

2. 在 Agent-host 里指定两个地址：

```powershell
$env:AGENT_HOST_RELAY = "http://127.0.0.1:8787"
$env:PUBLIC_RELAY_URL = "http://<这台电脑的局域网 IP>:8787"
npm start -- up
```

- `AGENT_HOST_RELAY`：电脑连 Relay 的地址。
- `PUBLIC_RELAY_URL`：写进二维码、手机访问的地址。
- 两者可以不同；手机必须能访问 `PUBLIC_RELAY_URL`。先在手机浏览器打开 `http://<局域网 IP>:8787/health` 确认。
- Windows 防火墙放行 8787。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AGENT_HOST_RELAY` | `https://relay.dshmobile.online` | 电脑连 Relay 的地址 |
| `PUBLIC_RELAY_URL` | 同 `AGENT_HOST_RELAY` | 二维码里给手机的地址 |
| `AGENT_HOST_CONFIG` | `%APPDATA%\agent-host\config.json` | 配置和凭据文件 |
| `DSH_PORT` | `3080` | 本机 DSH web 端口 |
| `DSH_DEVICE_NAME` | `<用户名>'s Computer` | 配对时显示的电脑名 |

凭据文件权限为 `0600`。二维码包含主密钥，不要截图分享。

## 常见问题

| 现象 | 检查 |
|---|---|
| 二维码过期 | 当前会自动生成新二维码；如果终端没有刷新，再重新运行 `npm start -- up` |
| 配对时报 `Pairing failed (401)` | 公共 Relay 与本地 Relay 的配对接口不一致；改用本仓库的 `dsh-scan-remote/relay` 或同版本部署 |
| 手机连不上 | 同一网络、防火墙、Relay 是否 `HOST=0.0.0.0`、`PUBLIC_RELAY_URL` 是否手机可达 |
| 终端 `Paired as` 但手机没反应 | App 版本是否支持 Agent-host（会请求 `/bus/describe`） |
| DSH 页面离线 | 先启动本机 DSH；`/bus` 接口仍然可用 |
| 撤销后手机还连着 | 等一次重连；必要时重启 App |

## 开发

```bash
npm test
npx tsx src/cli.ts up
```

- 协议 schema：`botbus-protocol/src/protocol.ts`
- 测试脚本：`scripts/`（`measure:snapshot`、`smoke:bus`、`smoke:ws`、`smoke:commands`、`probe:capacity`）
- 上游来源：见 [NOTICE](NOTICE)
