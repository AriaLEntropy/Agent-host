这个模块是电脑端的隧道设备端。它主动连到中转的 `/device`，把手机的请求搬进本进程。它不解析任务和命令。

每条消息是一个信封：`v` 固定为 1，再加上 `type`、`id`、`ts`、`payload`。带通道号的请求另有 `channel`。没有 `connect-ok` 和 `connect-error` 这两种类型。

连上之后电脑端先发 `auth`，带上电脑编号、凭据，并声明自己会 `sealed-tunnel-v1`。中转接受就回 `auth_ok`，然后电脑端每 25 秒发一次 `ping`，并上报本机 DSH 是否在线（`status`）。凭据被拒绝时中转直接断开，关闭码是 4003，不会重连。其他断开按指数退避重连。

手机接入时，中转送来 `client_hello`。电脑端用配对时的主密钥核对，成功就回 `server_hello`，失败就发 `device_close`，原因是 `e2ee_required` 或 `e2ee_handshake_failed`。之后两边的 HTTP 和 WebSocket 都封在 `sealed` 里，中转只看见密文。

解开之后按路径分两路。`/bus` 交给 `bus` 处理。其他路径转发到本机 DSH（默认 `127.0.0.1:3080`）。一条请求的回应是 `http_res`；一条 WebSocket 打开成功是 `ws_open_ok`，之后用 `ws_frame` 传数据，结束用 `ws_close`。

`pairing.ts` 和 `pair-link.ts` 负责扫码配对：向中转申请配对会话，在终端打印二维码，等手机确认后把凭据存到本机。`e2ee.ts` 负责这套隧道的密钥和加解密。`version.ts` 是连中转时带上的程序版本号。
