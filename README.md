# 局域网远程访问与控制 DeepSeek Harness

**Reach the DeepSeek Harness (dsh) web GUI from any device on your LAN**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh%200.1.5-4B6BFB)](#)
[![Node](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](#)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)](#)

手机或平板连上同一个 WiFi，打开浏览器就能操作电脑上的 dsh —— 看会话、发指令。
`dsh web` 本体**始终只监听 127.0.0.1**，暴露在局域网上的只有一个入口代理。

---

## 一、问题的本质

`dsh web` 只监听环回地址，这是刻意设计。所以手机直接访问 `http://<电脑IP>:3080` 会**连不上**——
不是防火墙挡住了，而是**根本没有监听在局域网地址上**。

本项目的做法：在两者之间放一个**入口代理**，它监听局域网地址，把请求转发给 `127.0.0.1:3080`。

```
手机 ──► http://192.168.x.x:3081 ──► dsh-entry-proxy.mjs ──► 127.0.0.1:3080 (dsh web)
              (绑 LAN 地址)                (本代理)                (始终只绑环回)
```

---

## 二、⚠️ 两个必须知道的技术点（否则做出来是坏的）

### 1. 不能改写 Host / Origin —— 必须在配置里声明可信主机

dsh 的 `/api` 有一道**浏览器信任围栏**：它取请求的 `Host`（或 `Origin`），要求两者一致，
且 authority 必须是**环回地址、或显式声明过的主机**。

后果：**任何反向代理都无法靠改写 Host 绕过它**（这正是它的目的——防 DNS rebinding）。

实测证据：用 `Host: 192.168.0.105:3081` 直连环回端口 → **403 Forbidden**；
把该 authority 加进 `trustedHosts` 后才放行。

所以部署时必须改 `cordis.patch.yml` 的**两处**（缺一不可，前者持有值、后者是围栏）：

```yaml
- id: web-runtime
  config:
    trustedHosts:
      - <电脑的LAN地址>
- id: connection
  config:
    trustedHosts:
      - <电脑的LAN地址>
```

### 2. 必须隧道 WebSocket —— 否则页面能开但一直"自动重连中"

dsh 的实时数据面走 **`/api/remote.mux`** 这个 WebSocket。
只转发普通 HTTP 的代理会导致：页面能渲染，但**会话列表为空**、左下角一直显示**"自动重连中"**。

本项目的代理实现了 `server.on('upgrade')` 原始 socket 双向隧道。**这一条是踩出来的**：
第一版代理没做，现象就是"看着正常、其实没连上"。

---

## 三、设计要点（为什么这么做）

| 决策 | 原因 |
|---|---|
| 代理绑 **LAN 地址**而不是 `0.0.0.0` | 只在需要的网络上可达；环回留给本机 |
| 由 **dsh 插件**启动代理，而不是独立计划任务 | 计划任务会和 dsh 抢端口；插件在 dsh 进程内启动，顺序天然正确 |
| 插件启动前**先健康探测** | 已在服务就复用，不产生重复实例 |
| 探测地址 = 绑定地址 | 对只绑 LAN 的代理探 `127.0.0.1` 必然 `ECONNREFUSED`，会导致每次启动都拉起一个注定失败的实例 |
| 子进程 `detached + unref` | 代理可活过本次 dsh 运行，下次启动直接复用 |
| 代理自己捕获 `EADDRINUSE` 后安静退出 | 第二道保险，不让端口冲突升级成崩溃 |
| 启动器先查端口再决定 | 否则每次双击都尝试起第二个实例，撞上 `EADDRINUSE 3080` |

---

## 四、目录结构

```
.
├── README.md
├── LICENSE
├── package.json
├── docs/
│   └── DEPLOY.md                     从零部署（6 步 + 12 条排错表）
└── src/
    ├── proxy/
    │   └── dsh-entry-proxy.mjs       入口代理（HTTP + WebSocket 隧道）
    ├── plugin/                       本地插件：随 dsh 自动拉起代理
    │   ├── package.json
    │   └── lib/index.js
    └── launcher/                     桌面启动器
        ├── dsh-hiboard.cmd           纯 ASCII（cmd.exe 按 ANSI 解码，中文会乱码）
        └── dsh-start.ps1             纯 ASCII（PS 5.1 无 BOM 时按 ANSI 解码）
```

---

## 五、快速开始

前置：Windows + Node.js 18+ + dsh 已安装 + `pnpm` 已安装。

```powershell
# 1) 放到「路径不含空格」的目录（pnpm 的 file: 依赖会被空格截断）
#    例：把 src\plugin 复制到 E:\dsh-vendor\dsh-entry-startup
#       把 src\proxy\dsh-entry-proxy.mjs 复制到 E:\DSH\dsh-entry-proxy.mjs

# 2) 安装代理插件
dsh plugin --profile web add "file:E:/dsh-vendor/dsh-entry-startup"

# 3) 写 profile 补丁层（trustedHosts 两处 + insert 插件条目）
#    见 docs/DEPLOY.md 第 3 步

# 4) 配置预检（只读，不起服务）
dsh --profile web --dump-config | Select-Object -First 5

# 5) 用 src\launcher\dsh-hiboard.cmd 启动（它会判断是否已在运行）
```

手机打开 `http://<电脑的LAN地址>:3081/?token=<token>`。
**成功判据**：完整 GUI + **侧边栏列出会话** + 左下角**不是**"自动重连中"。

完整步骤与排错表见 **[`docs/DEPLOY.md`](docs/DEPLOY.md)**。

---

## 六、排错速查（完整表见 DEPLOY.md）

| 现象 | 原因 |
|---|---|
| 手机打开是 **403** | `trustedHosts` 没加 LAN 地址，或只加了一处 |
| 手机打开 **401** | 地址漏了 `?token=`，或 dsh 重启后 token 已更换 |
| 会话列表为空 + 一直"自动重连中" | 代理没有 WebSocket 隧道 |
| 电脑自己能访问、手机不通 | 路由器开了 **AP 隔离** |
| `EADDRINUSE 3080` | 旧实例还健康地占着端口，**不代表崩溃**；先查端口占用 |
| `.cmd` 满屏"不是内部或外部命令" | cmd.exe 按系统 ANSI(GBK) 解码，UTF-8 中文注释变乱码并吃掉行首 `REM` |
| `.ps1` 报语法错 | 含非 ASCII 却没有 UTF-8 BOM，PS 5.1 按 ANSI 解码导致解析失败 |

---

## 七、安全

- 访问仍需 **dsh 自己的会话 token**（无 token 一律 401/403）；入口代理不是鉴权层。
- token **每次重启 dsh 都会更换**，启动器会自动捕获到 `~/.dsh/lan/web-state.json`。
- 关闭局域网入口：删掉 `cordis.patch.yml` 里那两条 `trustedHosts`，或结束代理进程。
- 电脑侧不需要开任何入站端口（代理只监听局域网地址，由 dsh 自己拉起）。

## 许可证

MIT，见 [`LICENSE`](LICENSE)。
