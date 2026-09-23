/**
 * dsh-entry-startup - 随 dsh 启动本地入口代理（局域网 + 公网中继）。
 *
 * `dsh web` 只绑定 127.0.0.1，手机无法直连，因此需要本地入口代理。两个代理都在
 * 这里由 dsh 进程自己启动，而不是交给独立启动器/计划任务——后者会和 dsh 抢端口。
 *
 *   lan  : 绑定本机 LAN 地址（默认 3081）——同 WiFi 手机访问
 *   relay: 绑定 127.0.0.1（默认 18080）——公网经 frpc/frps 反向隧道接入
 *
 * 设计要点：
 *   - 先做健康探测，已在服务的代理直接复用，不重复启动；
 *   - 子进程 detached + unref，可独立于本次 dsh 存活；
 *   - 代理自身在端口被占时安静退出，作为第二道保险；
 *   - 探测必须使用与绑定**相同**的地址：对只为 LAN 绑定的代理探 127.0.0.1 必然
 *     ECONNREFUSED，会导致每次启动都重复拉起。
 *
 * `Config` 必须是 schemastery schema：cordis 4 会调用
 * `Config["~standard"].validate(...)`，普通对象字面量会让它读到 undefined.validate，
 * 直接把整个 dsh 启动带崩（这个坑踩过一次）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import z from "@deepseek-ai/schemastery";

export const name = "entry-startup";
/** 注入 webServer，确保 GUI 已经开始监听后再拉代理。 */
export const inject = ["webServer"];

const ProxyEntry = z.object({
	label: z.string().default("proxy"),
	scriptPath: z.string().default(""),
	port: z.number().default(0),
	/** 留空表示绑定探测到的 LAN 地址；中继路径填 127.0.0.1。 */
	bindIp: z.string().default(""),
	enabled: z.boolean().default(true)
});

export const Config = z.object({
	proxies: z.array(ProxyEntry).default([]),
	target: z.string().default("http://127.0.0.1:3080"),
	healthTimeoutMs: z.number().default(2500)
});

/** 第一个非内部 IPv4 地址，与代理的默认绑定保持一致。 */
function detectLanIp() {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
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

export function apply(ctx, config) {
	const entries = (config?.proxies ?? []).filter((entry) => entry?.enabled !== false);
	if (entries.length === 0) return;

	const target = config?.target || "http://127.0.0.1:3080";
	const healthTimeoutMs = Number(config?.healthTimeoutMs) > 0 ? Number(config.healthTimeoutMs) : 2500;

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
		const bindIp = entry.bindIp || detectLanIp() || "127.0.0.1";

		ctx.effect(() => {
			let cancelled = false;
			(async () => {
				if (await proxyAlreadyServing(bindIp, port, healthTimeoutMs)) {
					ctx.logger?.info?.("[entry-startup] %s 已在 %s:%s 服务，复用", label, bindIp, port);
					return;
				}
				if (cancelled) return;
				const child = spawn(
					process.execPath || "node",
					[script, "--bind-ip", bindIp, "--port", String(port), "--target", target],
					{ detached: true, stdio: "ignore", windowsHide: true }
				);
				child.on("error", (error) => ctx.logger?.warn?.("[entry-startup] %s: 启动失败 %s", label, error.message));
				child.unref();
				ctx.logger?.info?.("[entry-startup] 已启动 %s (pid %s) 于 %s:%s", label, child.pid, bindIp, port);
			})();
			return () => {
				cancelled = true;
				// 代理是 detached 的，故意让它活过本次 dsh 运行。
			};
		}, `entry-startup: ${label}`);
	}
}
