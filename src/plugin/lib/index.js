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
import { existsSync } from "node:fs";
import os from "node:os";
import z from "@deepseek-ai/schemastery";

export const name = "entry-startup";
/** 注入 webServer，确保 GUI 已经开始监听后再拉入口进程。 */
export const inject = ["webServer"];

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
	healthTimeoutMs: z.number().default(2500)
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

function startProxies(ctx, entries, target, healthTimeoutMs) {
	for (const entry of entries) {
		const label = entry.label || "proxy";
		const script = entry.scriptPath ?? "";
		if (!script || !existsSync(script)) {
			ctx.logger?.warn?.("[entry-startup] %s: 脚本不存在 %s，跳过", label, script || "(未配置)");
			continue;
		}
		const port = Number(entry.port);
		if (!Number.isFinite(port) || port <= 0) {
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
					ctx.logger?.info?.("[entry-startup] %s 已在 %s:%s 服务，复用", label, bindIp, port);
					return;
				}
				if (cancelled) return;
				const args = explicitBind
					? [script, "--bind-ip", bindIp, "--port", String(port), "--target", target]
					: [script, "--port", String(port), "--target", target];
				const child = spawn(process.execPath || "node", args, { detached: true, stdio: "ignore", windowsHide: true });
				child.on("error", (error) => ctx.logger?.warn?.("[entry-startup] %s: 启动失败 %s", label, error.message));
				child.unref();
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

function startTunnels(ctx, entries) {
	for (const entry of entries) {
		const label = entry.label || "tunnel";
		const script = entry.scriptPath ?? "";
		const matchArg = entry.matchArg || (script ? script.split(/[\\/]/).pop() : "");
		if (!script || !existsSync(script)) {
			ctx.logger?.warn?.("[entry-startup] %s: 隧道脚本不存在 %s，跳过", label, script || "(未配置)");
			continue;
		}

		ctx.effect(() => {
			let cancelled = false;
			(async () => {
				if (matchArg && supervisorRunning(matchArg)) {
					ctx.logger?.info?.("[entry-startup] %s 已在运行（匹配 %s），复用", label, matchArg);
					return;
				}
				if (cancelled) return;
				// 隧道监督脚本用 PowerShell 跑：它内部是"起 ssh + 掉线重连"的循环，
				// 用 detached 启动，这样它既活过本次 dsh，也活过桌面停止脚本之外的场景。
				const child = spawn(
					process.platform === "win32" ? "powershell.exe" : "sh",
					process.platform === "win32"
						? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script]
						: [script],
					{ detached: true, stdio: "ignore", windowsHide: true }
				);
				child.on("error", (error) => ctx.logger?.warn?.("[entry-startup] %s: 启动失败 %s", label, error.message));
				child.unref();
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
	if (proxies.length === 0 && tunnels.length === 0) return;

	const target = config?.target || "http://127.0.0.1:3080";
	const healthTimeoutMs = Number(config?.healthTimeoutMs) > 0 ? Number(config.healthTimeoutMs) : 2500;

	startProxies(ctx, proxies, target, healthTimeoutMs);
	startTunnels(ctx, tunnels);
}
