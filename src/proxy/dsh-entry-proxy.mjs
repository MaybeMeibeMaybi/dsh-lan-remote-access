/**
 * dsh-entry-proxy.mjs - dsh web GUI 的本地入口代理（局域网 / 公网中继共用一份）。
 *
 * 为什么存在：
 *   `dsh web` 只监听 127.0.0.1，手机无法直接访问。本代理监听一个明确地址，
 *   把请求转发到 127.0.0.1:3080，而 dsh 本体始终不暴露。
 *
 * 三种用法（同一个脚本，只换参数）：
 *   局域网 + tailnet 自动：node dsh-entry-proxy.mjs --port 3081
 *        → 自动绑定「本机局域网地址」与「Tailscale 网卡地址（100.64.0.0/10）」，
 *          两者任一变化都会在 15 秒内自动补/撤监听。手机无论走局域网还是
 *          tailnet 都能连上，且电脑换网不需要人工干预。
 *   局域网直连（固定）：   node dsh-entry-proxy.mjs --bind-ip 192.168.0.x --port 3081
 *   公网中继（固定）：     node dsh-entry-proxy.mjs --bind-ip 127.0.0.1 --port 18080
 *        （18080 只允许本机 SSH 反向隧道送入；公网侧由中继服务器承接）
 *
 * 三个必须遵守的细节：
 *   1. Host / Origin 原样透传。dsh 的 /api 浏览器信任围栏比较这两者，且只接受
 *      环回或 profile 补丁层 trustedHosts 里声明过的 authority——改写 Host 没用。
 *      所以新增 tailnet 访问时，必须把电脑的 100.x 地址也写进 trustedHosts。
 *   2. WebSocket 升级必须做原始 socket 隧道。/api/remote.mux 承载 UI 的实时连接，
 *      少了它页面能渲染，但会话列表为空且一直"自动重连中"。
 *   3. Tailscale 网卡必须排除在"局域网地址"探测之外（见 VIRTUAL_ADAPTER），
 *      否则会把 100.x 当成局域网地址，换网跟随就会绑到手机上路由不到的地址。
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

/** Tailscale 的地址段（CGNAT 100.64.0.0/10）。 */
function isTailnetAddress(address) {
	if (!address.startsWith("100.")) return false;
	const second = Number(address.split(".")[1]);
	return second >= 64 && second <= 127;
}

/** 判断是否是可用的局域网地址：排除内部、APIPA(169.254)、Tailscale CGNAT(100.64/10)。 */
function usableLanAddress(address, name) {
	if (address.family !== "IPv4" || address.internal) return false;
	if (VIRTUAL_ADAPTER.test(name)) return false;
	if (address.address.startsWith("169.254.")) return false;
	if (isTailnetAddress(address.address)) return false;
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

/**
 * 探测 Tailscale 地址（100.64.0.0/10）。
 * 优先取网卡名含 tailscale 的，找不到再退化为"任何 CGNAT 地址"。
 * 没装 Tailscale / 未登录时返回 undefined，此时只监听局域网地址。
 */
function detectTailnetIp() {
	const names = Object.entries(os.networkInterfaces());
	for (const [name, addresses] of names) {
		if (!/tailscale/i.test(name)) continue;
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && isTailnetAddress(address.address)) return address.address;
		}
	}
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && isTailnetAddress(address.address)) return address.address;
		}
	}
	return undefined;
}

/** 探测到地址时所使用的网卡名，仅用于日志。 */
let LAN_IFACE = "";

const BIND_ARG = arg("bind-ip", "") || process.env.DSH_ENTRY_BIND_IP || "";
const PORT = Number(arg("port", "3081"));
const TARGET = new URL(arg("target", "http://127.0.0.1:3080"));
/** 当前实际绑定的局域网地址；IPv4 变化时会更新。 */
let LAN_IP = BIND_ARG || detectLanIp() || "127.0.0.1";
/** 显式指定 --bind-ip 时不做跟随（例如 0.0.0.0 或 127.0.0.1）。 */
const FOLLOW_LAN = BIND_ARG === "";

/** 已建立的监听：地址 -> http.Server。同一份请求逻辑可以挂在多个地址上。 */
const listeners = new Map();

/**
 * token 过期/缺失时的说明页（替换 dsh 那句含糊的英文）。
 *
 * 实测（2026-09-30）：dsh 的 authorizeIndex 只在
 *   GET + path 恰为 "/" + token 参数**恰好一个** + token 匹配本次启动的 token
 * 时才发 303 并下发会话 cookie；否则一律 401 并回
 *   "dsh web authentication required; reopen the URL printed by dsh web."
 * 而 token **每次重启 dsh 都会换**，所以从聊天记录/旧卡片里复制来的地址必然踩这一条。
 */
function staleTokenPage(hadToken) {
	const title = hadToken ? "此地址已过期" : "这个地址缺少 token";
	const detail = hadToken
		? "地址里的 token 属于**上一次启动**。dsh 每次重启都会更换 token，所以旧地址一定会被拒绝（这不是网络或围栏问题）。"
		: "局域网入口必须带上本次启动的 token（形如 <code>/?token=…</code>）。";
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh 入口 · ${title}</title>
<style>
 body{background:#16181d;color:#e6e8ee;font:16px/1.7 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;margin:0;padding:28px;display:flex;justify-content:center}
 .box{max-width:560px;width:100%}
 h1{font-size:20px;margin:0 0 12px}
 .tag{display:inline-block;padding:2px 8px;border-radius:6px;background:#3a2226;color:#ff9aa2;font-size:13px;margin-bottom:14px}
 ul{padding-left:22px} li{margin:6px 0}
 code{background:#22262e;padding:2px 6px;border-radius:5px;font-size:14px}
 .hint{margin-top:18px;padding:12px 14px;border-radius:9px;background:#1d2a22;border:1px solid #2c4a37}
 a{color:#7ab7ff}
</style></head>
<body><div class="box">
<div class="tag">HTTP 401 · 未通过认证</div>
<h1>${title}</h1>
<p>${detail}</p>
<div class="hint">
 <strong>怎么拿到能用的地址：</strong>
 <ul>
  <li>看手机<strong>负一屏</strong>里最新的那张「DeepSeek Harness本次启动地址」卡片 —— 卡片底部会写<strong>生成时间</strong>与 <code>token 尾 6 位</code>，用最新的那张；</li>
  <li>或者让电脑上重新推一张：删除旧卡片后等 30 秒（看门狗会自动补发），或直接重启一次 dsh；</li>
  <li>Tailscale 与阿里云两个入口<strong>不需要 token</strong>（只输密码），token 过期时它们照常可用。</li>
 </ul>
</div>
<p style="opacity:.7;font-size:13px;margin-top:16px">这条提示由本机入口代理生成（<code>dsh-entry-proxy.mjs</code>），用来替代 dsh 原本那句 “reopen the URL printed by dsh web”。</p>
</div></body></html>`;
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

/**
 * "从别的 App 点开链接" 的兼容垫片 —— 2026-09-30 用户实测报障的根因。
 *
 * 症状：手机上从负一屏卡片点开 `http://<lan>:3081/?token=…`，浏览器显示
 *   "dsh web authentication required; reopen the URL printed by dsh web."
 * 而同样的地址**手敲进地址栏**或**刷新一下**就正常 —— 我用 curl 验证也一直是好的。
 *
 * 根因：dsh 下发的会话 cookie 是 `SameSite=Strict`（dsh-client-connection 的
 * sessionCookie()）。从**另一个 App**（负一屏卡片）点开属于**跨站导航**：
 * 浏览器会把 Set-Cookie 存下来，但**在这次跨站导航链里不带它** → 紧跟的 `/`
 * 请求没有会话 → 401 → 那句提示。手敲地址或刷新属于**同站导航**，所以一直好。
 *
 * 垫片做法（不动 dsh、不放松 Strict）：带 token 的浏览器导航先在这里回一个极小的
 * 中转页，由它**同站**再跳一次；第二次请求就是同站导航，dsh 正常下发 cookie，
 * 浏览器也会在跳转链里带上它。
 *
 * 只拦"浏览器 + 带 token + 还没打过标记"的 GET；curl/脚本（无浏览器 UA）不受影响，
 * 仍拿到 dsh 原始的 303，现有验证脚本照旧。
 */
const BROWSER_UA = /Mozilla|AppleWebKit|Chrome|Chromium|Safari|Edg|Firefox|HuaweiBrowser|MicroMessenger|HeyTapBrowser/i;

function maybeServeHandoff(req, res) {
	if (req.method !== "GET") return false;
	const ua = String(req.headers["user-agent"] ?? "");
	if (!BROWSER_UA.test(ua)) return false;
	let url;
	try {
		url = new URL(req.url, "http://entry.invalid");
	} catch {
		return false;
	}
	if (!url.searchParams.has("token")) return false;
	if (url.searchParams.has("hs")) return false;

	url.searchParams.set("hs", "1");
	const next = `${url.pathname}?${url.searchParams.toString()}`;
	const body = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh 入口</title><style>body{background:#16181d;color:#e6e8ee;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}a{color:#7ab7ff}</style>
</head><body><div>正在进入 dsh…<br><a href="${next}">如果没有自动跳转，点这里</a></div>
<script>location.replace(${JSON.stringify(next)});</script></body></html>`;
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-length": String(Buffer.byteLength(body))
	});
	res.end(body);
	return true;
}

/** HTTP 转发。 */
function handleRequest(req, res) {
	// 客户端中途断开（切网、关页面、NAT 超时）不要让进程崩：入口代理上很常见。
	// 与网关同样的教训：一个未处理的 socket 'error' 就能让整个入口消失。
	req.on("error", () => {});
	res.on("error", () => {});
	req.socket?.on("error", () => {});
	if (req.url === "/__proxy_health") {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(`entry-proxy ok -> ${TARGET.origin}\n`);
		return;
	}

	if (maybeServeHandoff(req, res)) return;

	const proxyReq = http.request(
		{ protocol: TARGET.protocol, hostname: TARGET.hostname, port: TARGET.port, method: req.method, path: req.url, headers: copyHeaders(req.headers) },
		(proxyRes) => {
			// dsh 对"token 过期/缺失"只回一句含糊的 401 文本。用户复制的是**旧消息里的地址**
			// （每次重启 dsh 都会换 token），看到那句话根本不知道该做什么。这里把**正文**换成
			// 一张说明页：状态码仍是 401、不掩盖失败，但告诉用户去哪里拿最新地址。
			if (proxyRes.statusCode === 401 && req.method === "GET" && req.url.startsWith("/")) {
				const chunks = [];
				proxyRes.on("data", (c) => chunks.push(c));
				proxyRes.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if (!/authentication required/.test(text)) {
						res.writeHead(401, proxyRes.headers);
						res.end(text);
						return;
					}
					let hadToken = false;
					try {
						hadToken = new URL(req.url, "http://x").searchParams.has("token");
					} catch {
						hadToken = false;
					}
					const body = staleTokenPage(hadToken);
					res.writeHead(401, {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
						"content-length": String(Buffer.byteLength(body))
					});
					res.end(body);
				});
				return;
			}
			res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
			proxyRes.pipe(res);
		}
	);
	proxyReq.on("error", (error) => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end(`entry-proxy: upstream error: ${error.message}\n`);
	});
	req.pipe(proxyReq);
}

/** WebSocket / 其他 Upgrade：原始 socket 双向隧道。 */
function handleUpgrade(req, clientSocket, head) {
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
}

function handleClientError(_error, socket) {
	if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
}

/** 建一个监听实例（每个地址一个，共用同一套处理逻辑）。 */
function createEntryServer() {
	const server = http.createServer(handleRequest);
	server.on("upgrade", handleUpgrade);
	server.on("clientError", handleClientError);
	// 连接级错误必须兜住：有些客户端建连后、在发出任何请求之前就被重置
	// （NAT 超时、手机切网、扫描器探测）。这类 socket 不会进入 req/res 处理器，
	// 少了这个处理器，一个 ECONNRESET 就能把整个入口进程打崩。
	// 2026-09-27 实测：3081 代理就是这样静默消失的（日志 `read ECONNRESET / TCP.onStreamRead`）。
	server.on("connection", (socket) => {
		socket.on("error", () => {});
	});
	// 启动插件在每次 dsh 启动时都会尝试拉起本代理，抢占失败必须安静退出而不是抛错。
	// 只有"一个都没绑上"时才算另一个实例在服务；附加地址（tailnet）失败只记录不退出，
	// 否则 Tailscale 网卡抖动会连带把局域网入口打掉。
	server.on("error", (error) => {
		if (error?.code === "EADDRINUSE" && listeners.size === 0) {
			console.log(`entry-proxy: 端口 ${PORT} 已被占用，另一个实例在服务，安静退出。`);
			process.exit(0);
		}
		console.error(`entry-proxy: ${error?.code ?? ""} ${error?.message ?? String(error)}`);
	});
	return server;
}

function openListener(address) {
	if (listeners.has(address)) return;
	const server = createEntryServer();
	listeners.set(address, server);
	server.on("close", () => {
		if (listeners.get(address) === server) listeners.delete(address);
	});
	server.listen(PORT, address, () => {
		const suffix = address === LAN_IP && LAN_IFACE ? ` （网卡 ${LAN_IFACE}）` : "";
		console.log(`entry-proxy: http://${address}:${PORT}/ -> ${TARGET.origin}${suffix}`);
	});
}

function closeListener(address) {
	const server = listeners.get(address);
	if (!server) return;
	listeners.delete(address);
	try {
		server.close();
		// 旧连接（手机挂着的 WebSocket）不会自己断开，必须强制关闭，否则端口迟迟不释放。
		server.closeAllConnections?.();
	} catch (error) {
		console.error(`entry-proxy: 撤销 ${address} 失败 ${error?.message ?? String(error)}`);
	}
}

/** 期望监听的地址集合：跟随模式下 = 局域网地址 + tailnet 地址（如果有）。 */
function desiredAddresses() {
	if (!FOLLOW_LAN) return [LAN_IP];
	const addresses = [];
	const lan = detectLanIp();
	if (lan) addresses.push(lan);
	const tailnet = detectTailnetIp();
	if (tailnet) addresses.push(tailnet);
	if (addresses.length === 0) addresses.push(LAN_IP);
	return [...new Set(addresses)];
}

/** 对齐实际监听与期望监听；网卡/地址变化时自动补或撤。 */
function reconcile() {
	const desired = desiredAddresses();
	for (const address of desired) openListener(address);
	for (const address of [...listeners.keys()]) {
		if (!desired.includes(address)) {
			console.log(`entry-proxy: 地址 ${address} 已失效，撤销监听`);
			closeListener(address);
		}
	}
	if (desired[0] !== LAN_IP && desired[0] !== undefined) {
		console.log(`entry-proxy: LAN 地址由 ${LAN_IP} 变为 ${desired[0]}`);
		LAN_IP = desired[0];
	}
}

// 顶层兜底：入口代理同时承载局域网与 tailnet 两条路，进程"活着"比"干净退出"重要得多。
// 任何漏网的未处理异常都不应该让手机彻底失联（2026-09-27 因为一个 ECONNRESET 消失过一次）。
process.on("uncaughtException", (error) => {
	console.error(`entry-proxy: uncaughtException（已兜住，进程继续）：${error?.message ?? String(error)}`);
});
process.on("unhandledRejection", (reason) => {
	console.error(`entry-proxy: unhandledRejection（已兜住）：${reason?.message ?? String(reason)}`);
});

reconcile();
if (FOLLOW_LAN) {
	// 网卡变化及时兜底（有些网络切换不触发事件）；unref 让进程随时可退出。
	setInterval(reconcile, 15000).unref();
	console.log("entry-proxy: 已启用地址跟随（局域网 + tailnet，换网后自动重绑）");
}
