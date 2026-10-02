/**
 * dsh-entry-startup - 随 dsh 启动所有对外入口（本地代理 + SSH 反向隧道）
 *
 * `dsh web` 只绑定 127.0.0.1，所以手机无法直连，需要一组"入口进程"。它们都由
 * **dsh 进程自己**在启动时拉起，而不是交给独立启动器或计划任务——后者会和 dsh
 * 抢端口，也无法保证"在任何终端直接敲 dsh web"时被启动。
 *
 * 两条入口：
 *   proxies  ：入口代理，把 HTTP/WebSocket 转发到 127.0.0.1:3080
 *              - lan   : 绑定本机 LAN 地址（默认 3081）→ 同 WiFi 手机
 *              - relay : 绑定 127.0.0.1（默认 18080）→ 供隧道送入
 *   tunnels  ：SSH 反向隧道（取代 frp），由本机连出到中继服务器
 *              - 服务器侧只会得到 127.0.0.1:18080（环回），公网不暴露任何端口
 *
 * 设计要点：
 *   - 一律"先探测、再启动"：已在运行就复用，绝不重复拉起
 *   - 子进程 detached + unref，可独立于本次 dsh 存活
 *   - 代理自身在端口被占时安静退出，作为第二道保险
 *   - 探测地址必须与绑定地址一致（对只绑 LAN 的代理探 127.0.0.1 必然失败）
 *
 * `Config` 必须是 schemastery schema：cordis 4 会调用
 * `Config["~standard"].validate(...)`，普通对象字面量会让它读到 undefined.validate，
 * 直接把整个 dsh 启动带崩（这个坑踩过一次）。
 */

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

/**
 * 模块级证据（2026-09-30 彻查用）：**刻意放在文件最前面**，只要这个模块开始求值就写一行，
 * 带上真实路径。放在最后是不行的 —— 万一模块求值中途抛错，最后那行就永远不会执行，
 * 于是"没被加载"和"加载时报错"两种情况又混在一起了。
 *
 * 判据（配合 apply 里的那行）：
 *   有 import 行 + 有 apply 行      → 插件正常跑（那问题在别处）
 *   有 import 行 + 无 apply 行      → 加载了但 apply 没被调用（激活/inject 条件没满足）
 *   两行都没有                     → 模块根本没被 import（加载链/解析问题）
 */
try {
	appendFileSync(
		join(os.homedir(), ".dsh", "lan", "entry-startup-import.log"),
		`${new Date().toISOString()} imported pid=${process.pid} url=${import.meta.url}\n`
	);
} catch {
	// 日志失败不影响任何事
}

export const name = "entry-startup";
/**
 * **刻意不再声明静态 `inject = ["webServer"]`**（2026-09-30 彻查结论）。
 *
 * 实测证据：本模块**确实被 import 了**（模块级证据写下
 * `url=file:///…/node_modules/dsh-entry-startup/lib/index.js`，pid 与当次 dsh 一致），
 * 但 `apply` **一次都没被调用**（`entry-startup.log` 从未生成）——而同一次启动里
 * token-broadcast / push-guard / companion-startup 都正常 apply。
 * 结论：**不是插件逻辑错，而是它压根没被激活**。静态 inject 是本插件唯一与其他插件
 * 不同的声明，最可疑，所以改成"先 apply、需要时再等 webServer"：即使 inject 机制在这里
 * 不生效，插件也照常跑；原有"等 GUI 起来再拉入口进程"的意图用 `ctx.inject()` 保留。
 */

/**
 * 决策日志。
 *
 * 为什么需要（2026-09-30）：本插件的 logger 输出在 web profile 里**不落盘**（隐藏窗口），
 * 于是"某个入口到底有没有被拉起"事后完全查不到 —— 本机 8443 免 token 网关那天就没被
 * 拉起，而日志里一个字都没有，只能靠翻进程表和其他插件的日志反推。
 * 现在每个入口的探测结果与决定都写进这个文件，一行一个事实；
 * spawn 之后还会再确认一次"进程是否还活着"，因为**spawn 成功 ≠ 监督进程活着**
 * （那天正是"没有日志、没有进程"的沉默失败）。
 *
 * 与 dsh-companion-startup 的 trace() 同样的取舍：写得下就写，写不下就裁，
 * **绝不因为日志失败影响启动** —— 本插件在 dsh 的启动路径上。
 */
const TRACE_MAX_BYTES = 262144;
const TRACE_KEEP_LINES = 300;

function trace(path, message) {
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const info = existsSync(path) ? statSync(path) : undefined;
		if (info !== undefined && info.size > TRACE_MAX_BYTES) {
			const kept = readFileSync(path, "utf8").split(/\r?\n/).slice(-TRACE_KEEP_LINES).join("\n");
			writeFileSync(path, `${kept}\n`);
		}
		appendFileSync(path, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
	} catch {
		// 日志永远不是启动失败的理由。
	}
}

/** 进程是否还活着（signal 0 只做存在性检查）。 */
function processAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * spawn 之后过一会儿再核对一次：监督进程死了的话，日志里必须留下痕迹，
 * 否则现象就是"什么都没发生"（2026-09-30 排查了半天的那种沉默失败）。
 */
function confirmSupervisorAlive(path, label, pid, delayMs = 15000) {
	if (!pid) return;
	const timer = setTimeout(() => {
		trace(path, `tunnel ${label}: ${Math.round(delayMs / 1000)}s 后复核 pid=${pid} ${processAlive(pid) ? "仍在运行" : "**已退出**（spawn 成功但立刻死了，重点看这行）"}`);
	}, delayMs);
	timer.unref?.();
}

const ProxyEntry = z.object({
	label: z.string().default("proxy"),
	scriptPath: z.string().default(""),
	port: z.number().default(0),
	/** 留空表示绑定探测到的 LAN 地址；中继路径填 127.0.0.1。 */
	bindIp: z.string().default(""),
	enabled: z.boolean().default(true)
});

const TunnelEntry = z.object({
	label: z.string().default("tunnel"),
	/** 隧道监督脚本；它内部负责断线重连。 */
	scriptPath: z.string().default(""),
	/** 用于识别"已在运行"的命令行片段，必须唯一。 */
	matchArg: z.string().default(""),
	enabled: z.boolean().default(true)
});

export const Config = z.object({
	proxies: z.array(ProxyEntry).default([]),
	tunnels: z.array(TunnelEntry).default([]),
	target: z.string().default("http://127.0.0.1:3080"),
	healthTimeoutMs: z.number().default(2500),
	/** 决策日志路径；留空 = <用户目录>/.dsh/lan/entry-startup.log（空串可关闭日志）。 */
	tracePath: z.string().default("")
});

/**
 * 探测"本机局域网地址"，用于日志与健康探测。
 *
 * 必须排除两类网卡，否则会挑错地址（2026-09-27 真实踩过）：
 *   1. Tailscale 的 100.64.0.0/10（CGNAT）——装了 Tailscale 之后它常常排在前面，
 *      一旦被当成 LAN 地址，代理就只绑 tailnet、局域网反而连不上；
 *   2. 虚拟/隧道网卡（Hyper-V / VMware / VirtualBox / WSL / TAP 等）。
 * 与 dsh-entry-proxy.mjs 里的判定保持一致。
 */
const VIRTUAL_ADAPTER = /virtual|vmware|vbox|hyper-?v|wsl|tailscale|zerotier|docker|loopback|bluetooth|tap|tun|vpn|radmin|hamachi|npcap/i;

function isTailnetAddress(address) {
	if (!address.startsWith("100.")) return false;
	const second = Number(address.split(".")[1]);
	return second >= 64 && second <= 127;
}

function privateRank(address) {
	if (address.startsWith("192.168.")) return 0;
	if (address.startsWith("10.")) return 1;
	const [first, second] = address.split(".").map(Number);
	if (first === 172 && second >= 16 && second <= 31) return 2;
	return 3;
}

function detectLanIp() {
	const candidates = [];
	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		if (VIRTUAL_ADAPTER.test(name)) continue;
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			if (address.address.startsWith("169.254.")) continue;
			if (isTailnetAddress(address.address)) continue;
			candidates.push(address.address);
		}
	}
	candidates.sort((a, b) => privateRank(a) - privateRank(b));
	return candidates[0];
}

async function probeOnce(host, port, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://${host}:${String(port)}/__proxy_health`, { signal: controller.signal });
		const text = await response.text().catch(() => "");
		return response.ok && text.includes("entry-proxy ok");
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** 短暂重试：刚启动的代理可能还在绑定，单次失败会误判并重复拉起。 */
async function proxyAlreadyServing(host, port, timeoutMs, attempts = 3, gapMs = 700) {
	for (let i = 0; i < attempts; i += 1) {
		if (await probeOnce(host, port, timeoutMs)) return true;
		if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, gapMs));
	}
	return false;
}

/**
 * 判断某个监督脚本是否已在运行。
 *
 * 隧道无法用"端口探测"判断：它在**服务器**上开监听，本机看不到。所以改为按
 * 命令行匹配。用 PowerShell 的 CIM 查询而不是 tasklist，因为需要看完整命令行。
 * 查询失败一律当作"未运行"（宁可有重复检测，也不要漏启动）。
 */
function supervisorRunning(matchArg) {
	if (process.platform !== "win32") {
		try {
			const out = execFileSync("pgrep", ["-f", matchArg], { encoding: "utf8" });
			return out.trim().length > 0;
		} catch {
			return false;
		}
	}
	try {
		const escaped = matchArg.replace(/'/g, "''");
		const out = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.CommandLine -notlike '*subprocess-local*' -and $_.CommandLine -notlike '*runner.js*' }; if ($p) { 'YES' } else { 'NO' }`
			],
			{ encoding: "utf8", timeout: 20000, windowsHide: true }
		);
		return out.includes("YES");
	} catch {
		return false;
	}
}

function startProxies(ctx, entries, target, healthTimeoutMs, tracePath) {
	for (const entry of entries) {
		const label = entry.label || "proxy";
		const script = entry.scriptPath ?? "";
		if (!script || !existsSync(script)) {
			trace(tracePath, `proxy ${label}: 跳过——脚本不存在 ${script || "(未配置)"}`);
			ctx.logger?.warn?.("[entry-startup] %s: 脚本不存在 %s，跳过", label, script || "(未配置)");
			continue;
		}
		const port = Number(entry.port);
		if (!Number.isFinite(port) || port <= 0) {
			trace(tracePath, `proxy ${label}: 跳过——端口非法 ${String(entry.port)}`);
			ctx.logger?.warn?.("[entry-startup] %s: 端口非法 %s，跳过", label, String(entry.port));
			continue;
		}
		// bindIp 留空 = 交给代理自己做"多端点跟随"（局域网 + tailnet 同时监听，
		// 换网自动重绑）。所以这里只拿它做健康探测，**不再**把它塞进 --bind-ip，
		// 否则会把代理钉死在单个地址上（2026-09-27 踩过：只绑了 tailnet，局域网不通）。
		const explicitBind = Boolean(entry.bindIp);
		const bindIp = entry.bindIp || detectLanIp() || "127.0.0.1";

		ctx.effect(() => {
			let cancelled = false;
			(async () => {
				if (await proxyAlreadyServing(bindIp, port, healthTimeoutMs)) {
					trace(tracePath, `proxy ${label}: 已在 ${bindIp}:${port} 服务 → 复用（不重复拉起）`);
					ctx.logger?.info?.("[entry-startup] %s 已在 %s:%s 服务，复用", label, bindIp, port);
					return;
				}
				if (cancelled) {
					trace(tracePath, `proxy ${label}: 启动前被取消（插件已卸载）`);
					return;
				}
				const args = explicitBind
					? [script, "--bind-ip", bindIp, "--port", String(port), "--target", target]
					: [script, "--port", String(port), "--target", target];
				const child = spawn(process.execPath || "node", args, { detached: true, stdio: "ignore", windowsHide: true });
				child.on("error", (error) => {
					trace(tracePath, `proxy ${label}: **spawn 失败** ${error.message}`);
					ctx.logger?.warn?.("[entry-startup] %s: 启动失败 %s", label, error.message);
				});
				child.unref();
				trace(tracePath, `proxy ${label}: 探测未通过 → 拉起 pid=${child.pid}（${bindIp}:${port}，explicitBind=${explicitBind}）`);
				ctx.logger?.info?.(
					"[entry-startup] 已启动 %s (pid %s) %s",
					label,
					child.pid,
					explicitBind ? `于 ${bindIp}:${port}` : `于 ${bindIp}:${port}（地址跟随模式：局域网 + tailnet）`
				);
			})();
			return () => {
				cancelled = true;
				// 代理是 detached 的，故意让它活过本次 dsh 运行。
			};
		}, `entry-startup: ${label}`);
	}
}

function startTunnels(ctx, entries, tracePath) {
	for (const entry of entries) {
		const label = entry.label || "tunnel";
		const script = entry.scriptPath ?? "";
		const matchArg = entry.matchArg || (script ? script.split(/[\\/]/).pop() : "");
		if (!script || !existsSync(script)) {
			trace(tracePath, `tunnel ${label}: 跳过——脚本不存在 ${script || "(未配置)"}`);
			ctx.logger?.warn?.("[entry-startup] %s: 隧道脚本不存在 %s，跳过", label, script || "(未配置)");
			continue;
		}

		ctx.effect(() => {
			let cancelled = false;
			(async () => {
				const running = matchArg ? supervisorRunning(matchArg) : false;
				if (running) {
					trace(tracePath, `tunnel ${label}: 监督进程已在运行（匹配 "${matchArg}"）→ 复用`);
					ctx.logger?.info?.("[entry-startup] %s 已在运行（匹配 %s），复用", label, matchArg);
					return;
				}
				if (cancelled) {
					trace(tracePath, `tunnel ${label}: 启动前被取消（插件已卸载）`);
					return;
				}
				// 隧道监督脚本用 PowerShell 跑：它内部是"起 ssh / 起网关 + 掉线重连"的循环。
				//
				// **必须 detached:false（2026-10-02 实测定论，别再改回 true）**
				// 日志证据：用 detached:true 时每条隧道都是
				//   "已拉起 pid=…" → 15 秒后复核 → "已退出（spawn 成功但立刻死了）"，
				// 三个监督进程一次都没活下来 —— 8443 网关、SSH 隧道、看门狗全缺，
				// 而同样参数 spawn 的 **node** 入口代理却一直好好的（问题只在 powershell）。
				// 对照实验（E:\DSH\dsh-tunnel\_diag-detached-vs-not.mjs，同参数同脚本）：
				//   detached:true  → 标记文件没出现（powershell 什么都没做就退出）
				//   detached:false → 标记文件正常写出
				// 与 dsh-companion-startup 头注释的结论一字不差：
				//   "spawn 用 detached:false：这是实测结论，用 detached 会让 powershell.exe
				//    什么都不做就退出。"
				// unref() 照旧保留：它只影响父进程的事件循环引用，与 detached 无关。
				trace(tracePath, `tunnel ${label}: 监督进程不在（匹配 "${matchArg}" 无结果）→ 拉起 ${script}`);
				const child = spawn(
					process.platform === "win32" ? "powershell.exe" : "sh",
					process.platform === "win32"
						? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script]
						: [script],
					{ detached: false, stdio: "ignore", windowsHide: true }
				);
				child.on("error", (error) => {
					trace(tracePath, `tunnel ${label}: **spawn 失败** ${error.message}`);
					ctx.logger?.warn?.("[entry-startup] %s: 启动失败 %s", label, error.message);
				});
				child.unref();
				trace(tracePath, `tunnel ${label}: 已拉起 pid=${child.pid}`);
				confirmSupervisorAlive(tracePath, label, child.pid);
				ctx.logger?.info?.("[entry-startup] 已启动 %s (pid %s)", label, child.pid);
			})();
			return () => {
				cancelled = true;
				// 隧道是 detached 的，故意让它活过本次 dsh 运行。
			};
		}, `entry-startup: ${label}`);
	}
}

export function apply(ctx, config) {
	const proxies = (config?.proxies ?? []).filter((entry) => entry?.enabled !== false);
	const tunnels = (config?.tunnels ?? []).filter((entry) => entry?.enabled !== false);
	/**
	 * tracePath 的取值**踩过一次大坑（2026-09-30）**：
	 * schemastery 会把没配的字段填成它的 default —— 也就是**空串**；而早期写法是
	 * "空串 = 关掉日志"，于是 `trace("")` 直接 return：**插件其实跑得好好的
	 * （入口代理就是它拉起来的，父进程 = dsh 进程可证），却一条日志都不留**。
	 * 我被"没有日志"误导，得出"apply 从没被调用"的结论，白查了半天。
	 * 现在：空串 = 用默认路径（要关日志请显式删掉这一项并改代码，别再用空串表示"关"）。
	 */
	const configuredTrace = String(config?.tracePath ?? "").trim();
	const tracePath = configuredTrace || join(os.homedir(), ".dsh", "lan", "entry-startup.log");

	// 2026-09-30：把"进入 apply"这一步**无条件**记下来（原来写在提前 return 之后，
	// 于是"配置没传进来"这种情况会完全静默 —— 现象就是"插件像没跑一样"）。
	const rawKeys = config && typeof config === "object" ? Object.keys(config).join(",") : String(config);
	trace(tracePath, `--- entry-startup apply：pid=${process.pid} proxies=${proxies.length} tunnels=${tunnels.length} configKeys=[${rawKeys}] ---`);

	if (proxies.length === 0 && tunnels.length === 0) {
		trace(tracePath, "apply 提前返回：既没有 proxies 也没有 tunnels（配置没传进来？）");
		return;
	}

	const target = config?.target || "http://127.0.0.1:3080";
	const healthTimeoutMs = Number(config?.healthTimeoutMs) > 0 ? Number(config.healthTimeoutMs) : 2500;

	/** 真正的启动动作；由下面按 webServer 是否就绪来决定何时调用。 */
	const start = (why) => {
		trace(tracePath, `开始拉起入口进程（${why}）：proxies=${proxies.length} tunnels=${tunnels.length}`);
		try {
			startProxies(ctx, proxies, target, healthTimeoutMs, tracePath);
		} catch (error) {
			trace(tracePath, `startProxies 抛错：${error?.message ?? String(error)}`);
		}
		// 隧道这一段单独 try/catch：2026-09-30 实测出现过"代理起来了、三个隧道一个都没起、
		// 又没有任何日志"的情况 —— 把异常写进日志，下次就能一眼看出是哪一步断的。
		try {
			startTunnels(ctx, tunnels, tracePath);
			trace(tracePath, "startTunnels 返回（各隧道的决定见上面逐条记录）");
		} catch (error) {
			trace(tracePath, `startTunnels 抛错：${error?.stack ?? error?.message ?? String(error)}`);
		}
		trace(tracePath, "--- entry-startup apply 完成 ---");
	};

	// 兼容三种运行环境（顺序即优先级）：
	//   1. ctx.get("webServer") 已有 → 直接启动（绝大多数情况）
	//   2. 有 ctx.inject() → 等 webServer 就绪再启动（保留原有意图）
	//   3. 两者都没有（例如隔离自测用的假 ctx）→ 立即启动
	if (typeof ctx.get === "function" && ctx.get("webServer") !== undefined) {
		start("webServer 已就绪");
	} else if (typeof ctx.inject === "function") {
		trace(tracePath, "webServer 尚未就绪：注册 ctx.inject 等待后再拉起入口进程");
		ctx.inject(["webServer"], () => start("webServer 就绪（inject 回调）"));
	} else {
		start("ctx 无 get/inject（隔离运行）");
	}
}
