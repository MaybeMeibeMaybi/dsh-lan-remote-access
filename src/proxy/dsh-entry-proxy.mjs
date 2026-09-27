/**
 * dsh-entry-proxy.mjs - dsh web GUI 的本地入口代理（局域网 / 公网中继共用一份）。
 *
 * 为什么存在：
 *   `dsh web` 只监听 127.0.0.1，手机无法直接访问。本代理监听一个明确地址，
 *   把请求转发到 127.0.0.1:3080，而 dsh 本体始终不暴露。
 *
 * 两种用法（同一个脚本，只换参数）：
 *   局域网直连：node dsh-entry-proxy.mjs --port 3081
 *               （不带 --bind-ip 时**自动探测并跟随**本机局域网地址，换网不用改配置）
 *   公网中继  ：node dsh-entry-proxy.mjs --bind-ip 127.0.0.1 --port 18080
 *               （18080 只允许本机隧道送入；公网侧由中继服务器:18080 承接）
 *
 * 两个必须遵守的细节：
 *   1. Host / Origin 原样透传。dsh 的 /api 浏览器信任围栏比较这两者，且只接受
 *      环回或 profile 补丁层 trustedHosts 里声明过的 authority——改写 Host 没用。
 *   2. WebSocket 升级必须做原始 socket 隧道。/api/remote.mux 承载 UI 的实时连接，
 *      少了它页面能渲染，但会话列表为空且一直"自动重连中"。
 *
 * 安全：访问仍需 dsh 自己的会话 token（无 token 一律 401/403），本代理不是鉴权层。
 */

import http from "node:http";
import os from "node:os";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

/**
 * 虚拟 / 隧道网卡名黑名单。
 *
 * 为什么需要：`os.networkInterfaces()` 的顺序不保证把真实局域网网卡放前面。
 * 一旦机器上出现 Tailscale(100.64/10)、Hyper-V、VirtualBox、WSL 之类网卡，
 * 「取第一个地址」就可能绑到手机上根本路由不到的地址上——表现和踩过的
 * 「绑在过期 IP 上」完全一样（页面能开、会话为空、一直"自动重连中"）。
 */
const VIRTUAL_ADAPTER = /virtual|vmware|vbox|hyper-?v|wsl|tailscale|zerotier|docker|loopback|bluetooth|tap|tun|vpn|radmin|hamachi|npcap|loopback/i;

/** 判断是否是可用的局域网地址：排除内部、APIPA(169.254)、Tailscale CGNAT(100.64/10)。 */
function usableLanAddress(address, name) {
	if (address.family !== "IPv4" || address.internal) return false;
	if (VIRTUAL_ADAPTER.test(name)) return false;
	if (address.address.startsWith("169.254.")) return false;
	const second = Number(address.address.split(".")[1]);
	if (address.address.startsWith("100.") && second >= 64 && second <= 127) return false;
	return true;
}

/** RFC1918 私有网段优先级：192.168 > 10 > 172.16-31 > 其他（越小越优先）。 */
function privateRank(address) {
	if (address.startsWith("192.168.")) return 0;
	if (address.startsWith("10.")) return 1;
	const [first, second] = address.split(".").map(Number);
	if (first === 172 && second >= 16 && second <= 31) return 2;
	return 3;
}

/** 探测本机局域网地址，用于"跟随 DHCP 变化"的默认绑定。 */
function detectLanIp() {
	const candidates = [];
	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (usableLanAddress(address, name)) candidates.push({ name, address: address.address });
		}
	}
	candidates.sort((a, b) => privateRank(a.address) - privateRank(b.address));
	const chosen = candidates[0];
	if (chosen) LAN_IFACE = chosen.name;
	return chosen?.address;
}

/** 探测到地址时所使用的网卡名，仅用于日志。 */
let LAN_IFACE = "";

const BIND_ARG = arg("bind-ip", "") || process.env.DSH_ENTRY_BIND_IP || "";
const PORT = Number(arg("port", "3081"));
const TARGET = new URL(arg("target", "http://127.0.0.1:3080"));
/** 当前实际绑定的地址；IPv4 变化时会更新。 */
let LAN_IP = BIND_ARG || detectLanIp() || "127.0.0.1";
/** 显式指定 --bind-ip 时不做跟随（例如 0.0.0.0 或 127.0.0.1）。 */
const FOLLOW_LAN = BIND_ARG === "";

/**
 * 跟随本机 LAN 地址变化。
 *
 * 为什么需要：电脑会在不同网络间切换，DHCP 会换掉局域网地址。
 * 早期版本只在启动时绑定当时的地址，换网后就"绑在一个已不存在的 IP 上"，
 * 手机表现为能打开缓存页面但一直"自动重连中"（这是真实踩过的故障）。
 *
 * 做法：监听网卡事件 + 定时兜底复查；发现地址变了就 re-listen 到新地址。
 * 注意重绑期间会有极短的连接中断，但不会退出进程（老版本会因 EADDRINUSE 直接退出）。
 */
function currentLanIp() {
	return detectLanIp();
}
function followLanAddress(server) {
	if (!FOLLOW_LAN) return;
	let rebinding = false;
	const check = () => {
		if (rebinding) return;
		const now = currentLanIp();
		if (!now || now === LAN_IP) return;
		rebinding = true;
		const previous = LAN_IP;
		LAN_IP = now;
		console.log(`entry-proxy: LAN 地址由 ${previous} 变为 ${now}，重新绑定`);
		try {
			server.close(() => {
				server.listen(PORT, LAN_IP, () => {
					console.log(`entry-proxy: 已重新绑定 http://${LAN_IP}:${String(PORT)}/ -> ${TARGET.origin}`);
					rebinding = false;
				});
			});
			// 旧连接（例如手机还挂着的 WebSocket）不会自己断开，必须强制关闭，
			// 否则 close() 的回调永远不触发，代理就卡死在"已关闭端口"的状态。
			server.closeAllConnections?.();
		} catch (error) {
			console.error(`entry-proxy: 重绑失败 ${error?.message ?? String(error)}`);
			rebinding = false;
		}
	};
	// 网卡变化立即触发；另有定时兜底（有些网络切换不触发事件）
	try {
		os.networkInterfaces();
		setInterval(check, 15000).unref();
	} catch {
		/* 忽略 */
	}
}

/** 去掉逐跳首部；Host / Origin / Cookie 一律原样透传。 */
function copyHeaders(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers)) {
		const key = k.toLowerCase();
		if (key === "connection" || key === "keep-alive" || key === "transfer-encoding" || key === "upgrade") continue;
		if (v !== undefined) out[key] = v;
	}
	return out;
}

const server = http.createServer((req, res) => {
	if (req.url === "/__proxy_health") {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(`entry-proxy ok -> ${TARGET.origin}\n`);
		return;
	}

	const proxyReq = http.request(
		{ protocol: TARGET.protocol, hostname: TARGET.hostname, port: TARGET.port, method: req.method, path: req.url, headers: copyHeaders(req.headers) },
		(proxyRes) => {
			res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
			proxyRes.pipe(res);
		}
	);
	proxyReq.on("error", (error) => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end(`entry-proxy: upstream error: ${error.message}\n`);
	});
	req.pipe(proxyReq);
});

/** WebSocket / 其他 Upgrade：原始 socket 双向隧道。 */
server.on("upgrade", (req, clientSocket, head) => {
	const headers = copyHeaders(req.headers);
	headers.connection = "Upgrade";
	if (req.headers.upgrade !== undefined) headers.upgrade = req.headers.upgrade;

	const upstreamReq = http.request({
		protocol: TARGET.protocol,
		hostname: TARGET.hostname,
		port: TARGET.port,
		method: req.method,
		path: req.url,
		headers
	});

	upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
		clientSocket.write(
			`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n` +
			Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n"
		);
		if (upstreamHead?.length) clientSocket.unshift(upstreamHead);
		if (head?.length) upstreamSocket.unshift(head);
		upstreamSocket.pipe(clientSocket);
		clientSocket.pipe(upstreamSocket);
		const closeBoth = () => {
			clientSocket.destroy();
			upstreamSocket.destroy();
		};
		upstreamSocket.on("error", closeBoth);
		clientSocket.on("error", closeBoth);
		upstreamSocket.on("close", closeBoth);
		clientSocket.on("close", closeBoth);
	});

	upstreamReq.on("response", (upstreamRes) => {
		clientSocket.write(
			`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n` +
			Object.entries(upstreamRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n"
		);
		upstreamRes.pipe(clientSocket);
	});

	upstreamReq.on("error", (error) => {
		console.error(`entry-proxy: upgrade error: ${error.message}`);
		if (clientSocket.writable) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	});

	upstreamReq.end();
});

server.on("clientError", (_error, socket) => {
	if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// 启动插件在每次 dsh 启动时都会尝试拉起本代理，抢占失败必须安静退出而不是抛错。
server.on("error", (error) => {
	if (error?.code === "EADDRINUSE") {
		console.log(`entry-proxy: 端口 ${PORT} 已被占用，另一个实例在服务，安静退出。`);
		process.exit(0);
	}
	console.error(`entry-proxy: ${error?.message ?? String(error)}`);
	process.exit(1);
});

server.listen(PORT, LAN_IP, () => {
	console.log(`entry-proxy: http://${LAN_IP}:${PORT}/ -> ${TARGET.origin}${LAN_IFACE ? ` （网卡 ${LAN_IFACE}）` : ""}`);
	if (FOLLOW_LAN) console.log("entry-proxy: 已启用 LAN 地址跟随（换网后自动重绑）");
	followLanAddress(server);
});
