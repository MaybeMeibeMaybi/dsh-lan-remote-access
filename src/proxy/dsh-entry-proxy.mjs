/**
 * dsh-entry-proxy.mjs - dsh web GUI 的本地入口代理（局域网 / 公网中继共用一份）。
 *
 * 为什么存在：
 *   `dsh web` 只监听 127.0.0.1，手机无法直接访问。本代理监听一个明确地址，
 *   把请求转发到 127.0.0.1:3080，而 dsh 本体始终不暴露。
 *
 * 两种用法（同一个脚本，只换参数）：
 *   局域网直连：node dsh-entry-proxy.mjs --bind-ip 192.168.0.105 --port 3081
 *   公网中继  ：node dsh-entry-proxy.mjs --bind-ip 127.0.0.1     --port 18080
 *               （18080 只允许本机 frpc 送入；公网侧由中继服务器:18080 承接）
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

/** 第一个非内部 IPv4 地址，用于"跟随 DHCP 变化"的默认绑定。 */
function detectLanIp() {
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

const LAN_IP = arg("bind-ip", detectLanIp() ?? "127.0.0.1");
const PORT = Number(arg("port", "3081"));
const TARGET = new URL(arg("target", "http://127.0.0.1:3080"));

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
	console.log(`entry-proxy: http://${LAN_IP}:${PORT}/ -> ${TARGET.origin}`);
});
