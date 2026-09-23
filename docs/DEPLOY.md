# 从零部署：局域网手机访问 dsh

目标机器：Windows + Node.js 18+ + dsh 已安装 + pnpm 已安装。全程约 10 分钟。

---

## 前置检查（30 秒，能省掉后面大半排错）

```powershell
# 1) 本机 LAN 地址（记下来，后面要填）
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object IPAddress, InterfaceAlias

# 2) 确认 dsh 只在环回监听（这是预期的）
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object LocalAddress, LocalPort

# 3) pnpm 是否可用（dsh plugin 依赖它）
pnpm --version
```

---

## 第 1 步：放置源码（**路径不能含空格**）

pnpm 的 `file:` 依赖会把含空格的路径截断（报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。

```powershell
New-Item -ItemType Directory -Force -Path 'E:\dsh-vendor\dsh-entry-startup' | Out-Null
Copy-Item -Recurse -Force '<本项目>\src\plugin\*' 'E:\dsh-vendor\dsh-entry-startup\'

New-Item -ItemType Directory -Force -Path 'E:\DSH' | Out-Null
Copy-Item -Force '<本项目>\src\proxy\dsh-entry-proxy.mjs' 'E:\DSH\dsh-entry-proxy.mjs'
```

---

## 第 2 步：安装代理插件

```powershell
dsh plugin --profile web add "file:E:/dsh-vendor/dsh-entry-startup"
```

> **注意**：该插件**不要**写进 `dsh.profile.bundles`。它没有自己的 bundle patch，
> 列进 bundles 会让 dsh 拒绝启动并报
> `profile bundle "dsh-entry-startup" declares no dsh.bundle in its package.json`。
> 正确做法是用 profile 补丁层的 `insert`（第 3 步）。

---

## 第 3 步：写 profile 补丁层

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**在同一个文件里**加两段
（顺序：先 `trustedHosts` 覆盖，再 `insert` 插件；文件末尾是 `hiboard-push` 的话保留不动）：

```yaml
# ---- 信任围栏：把手机访问用的 authority 声明为可信 ----
# 两处必须一致：web-runtime 持有它，connection 是消费它的围栏。
- id: web-runtime
  config:
    trustedHosts:
      - <电脑的LAN地址>          # 例：192.168.0.105
- id: connection
  config:
    trustedHosts:
      - <电脑的LAN地址>

# ---- 入口代理：由 dsh 自己拉起 ----
- insert:
    - id: entry-startup
      name: dsh-entry-startup
      config:
        target: 'http://127.0.0.1:3080'
        proxies:
          - label: lan-proxy
            scriptPath: 'E:\DSH\dsh-entry-proxy.mjs'
            port: 3081
```

要点：
- `scriptPath` 指向第 1 步复制的代理脚本。
- `bindIp` 留空 → 插件自动探测本机第一个非内部 IPv4（即 LAN 地址）。
- 该层是 dsh 的**热重载层**，但 `trustedHosts` 只在启动时读取，因此仍需重启（第 5 步）。

---

## 第 4 步：配置预检（只读，不起服务）

```powershell
dsh --profile web --dump-config | Select-Object -First 5
```

- 正常：输出**上万字符**，且能搜到 `id: entry-startup`
- 异常：输出几百字符并伴随 `Error:` → **不要重启**，按报错里的
  `failed to apply loader entry <id>` 定位是哪一条

---

## 第 5 步：重启 dsh 并验证

```powershell
# 若 3080 已被健康实例占用，不必重启（新实例只会抢端口报 EADDRINUSE）
Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
```

用启动器启动（`src/launcher/dsh-hiboard.cmd` 拷到桌面；它只在未运行时才启动新实例）：

```
双击 dsh-hiboard.cmd
```

> ⚠️ **不要**用 `Start-Process -FilePath 'dsh'`：`dsh` 解析到 `dsh.ps1`（ExternalScript），
> 会报「不是有效的 Win32 应用程序」。必须 `node.exe + bin.js`，启动器已如此实现。

验证：

```powershell
# 1) 三个端口都应 LISTEN
Get-NetTCPConnection -LocalPort 3080,3081 -State Listen | Select-Object LocalPort, LocalAddress

# 2) 代理健康端点（用 LAN 地址，不要用 127.0.0.1 —— 代理只绑 LAN）
Invoke-WebRequest -UseBasicParsing 'http://<电脑的LAN地址>:3081/__proxy_health' | Select-Object -Expand Content
# 期望：entry-proxy ok -> http://127.0.0.1:3080

# 3) 取当前 token
(Get-Content "$env:USERPROFILE\.dsh\lan\web-state.json" -Raw | ConvertFrom-Json).token
```

**手机打开**：`http://<电脑的LAN地址>:3081/?token=<上面的token>`

**成功判据**：能看到完整 GUI，**侧边栏列出你的会话**，且左下角**不是**"自动重连中"。

---

## 第 6 步：排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 手机连不上/超时 | 代理没起，或不在同一网段 | 查第 5 步的端口与健康端点；确认手机连的是同一 WiFi |
| 手机打开是 **403** | `trustedHosts` 没加 LAN 地址（或只加了一处） | 两处都要加，重启 dsh |
| 手机打开 **401** | 地址里漏了 `?token=`，或 token 过期（dsh 重启过） | 从 `web-state.json` 取新 token |
| 页面能开但**会话列表为空**、一直"自动重连中" | 代理没有 WebSocket 隧道 | 确认用的是本项目的 `dsh-entry-proxy.mjs`（含 `server.on('upgrade')`） |
| dsh 启动崩：`Cannot find package 'dsh-entry-startup'` | 插件没装进 profile | 重跑第 2 步 |
| dsh 启动崩：`declares no dsh.bundle` | 插件被误写进 `dsh.profile.bundles` | 从 bundles 移除，改用第 3 步的 `insert` |
| dsh 启动崩：`reading 'validate'` | 插件 `Config` 不是 schemastery schema | 用本包 `src/plugin/lib/index.js`（已是 `z.object`） |
| `EADDRINUSE 3080` | 旧实例还健康地占着端口，新实例抢不到 | **通常不是崩溃**：先查端口占用，或直接访问旧实例 |
| 代理起来了但**手机还是不通**，电脑自己访问正常 | 路由器开了 **AP 隔离** | 在路由器里关闭 AP 隔离（或换 2.4G/5G 同网段） |
| 改了 `.ps1` 后启动器报语法错 | 文件含非 ASCII 但**没有 UTF-8 BOM**（PS 5.1 按 ANSI 解码） | 保持纯 ASCII，或用 `E:\DSH\_tools\Write-TextSafe.ps1` 写出带 BOM 的文件 |
| 改了 `.cmd` 后满屏"不是内部或外部命令" | cmd.exe 按系统 ANSI（GBK）解码，UTF-8 中文注释变乱码并吃掉行首 `REM` | **`.cmd`/`.bat` 保持纯 ASCII** |

---

## 附：为什么"探测必须用绑定的同一地址"

插件判断"代理是否已在服务"时，会对**代理绑定的地址**做健康探测。
如果代理只绑 LAN 地址，而插件去探 `127.0.0.1:3081`，结果永远是 `ECONNREFUSED`，
于是每次 dsh 启动都会重复拉起一个必然失败的第二实例。
本包插件已按"绑定地址 = 探测地址"实现。
