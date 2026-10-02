/**
 * Push-Alert.mjs - 从一个**独立进程**推一张告警卡片，不需要 dsh 在跑。
 *
 * 为什么需要：2026-10-02 23:30 那次自动重启，驱动把 dsh 停掉之后启动失败，
 * 机器上足足 3 分钟没有 dsh —— 而"没人知道"正是最糟的部分（用户是自己敲 dsh web 才发现的）。
 * 这类"dsh 不在线"的告警不可能由 dsh 里的插件发出，所以必须有一个独立进程的推送入口。
 *
 * 走的是**新进程直发 HTTPS**（不是 dsh 进程内发）：2026-09-30 的实测结论是
 * "同一份字节，dsh 进程内 107 次全 404，换个新进程发就 200"，本脚本天生就是新进程。
 *
 * 用法：
 *   node Push-Alert.mjs --name "⛔ dsh 自动重启失败" --content "正文（Markdown）" [--result "需要处理"]
 * 输出：一行 JSON：{"ok":true,"status":200,...}
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";

const PUSH_URL = "https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/claw/msg/upload";

const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const cardName = arg("name", "dsh 告警");
const content = arg("content", "");
const result = arg("result", "需要处理");
const scheduleId = arg("schedule-id", "dsh_token_notice");
const template = arg("template", "");
const detail = arg("detail", "");

/**
 * 内置模板：中文告警文案放这里（本文件是 UTF-8 的 .mjs），
 * 这样调用方 Restart-Dsh.ps1 可以保持**纯 ASCII**（PowerShell 5.1 无 BOM 时按 ANSI 解码）。
 */
const TEMPLATES = {
	"restart-failed": {
		name: "⛔ dsh 自动重启失败：机器上现在没有 dsh",
		result: "需要手动恢复",
		body: () => [
			"# ⛔ dsh 没能自动起来",
			"",
			"重启驱动已经停掉旧实例，但**新实例两条启动路径都没成功**（纯 `dsh web` 与桌面启动器）。",
			"**现在这台机器上没有 dsh 在跑。**",
			"",
			"## 怎么恢复",
			"",
			"1. 在任意终端执行一次 `dsh web`（或双击桌面 `dsh.bat`）；",
			"2. 起来之后本次 token 卡片会照常推给你 —— 本次没有可推的地址与 token。",
			"",
			"## 证据",
			"",
			"```",
			detail || "(没有附带证据路径)",
			"```",
			"",
			"> 这条告警由重启驱动在**两条启动路径都失败**时发出；它不依赖 dsh（独立进程直发）。"
		].join("\n")
	}
};
const picked = template ? TEMPLATES[template] : undefined;
const finalName = picked ? picked.name : cardName;
const finalResult = picked ? picked.result : result;
const finalContent = picked ? picked.body() : content;

/** authCode 与插件同源：profile 的 cordis.patch.yml（不写死在脚本里）。 */
function resolveAuthCode() {
	if (process.env.DSH_HIBOARD_AUTH_CODE) return process.env.DSH_HIBOARD_AUTH_CODE.trim();
	try {
		const yml = readFileSync(join(homedir(), ".dsh", "profiles", "web", "cordis.patch.yml"), "utf8");
		const match = yml.match(/^\s*authCode:\s*['"]?([A-Za-z0-9_-]+)/m);
		if (match) return match[1];
	} catch {
		// 读不到就当作没配置
	}
	return "";
}

function post(payload, pinnedIp = "") {
	return new Promise((resolve) => {
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		const target = new URL(PUSH_URL);
		/** 钉地址时仍然用域名做 SNI/Host（证书校验照旧），只是不再走解析。 */
		const options = {
			method: "POST",
			hostname: target.hostname,
			port: 443,
			path: target.pathname,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-length": String(body.byteLength),
				"x-trace-id": `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`
			},
			timeout: 20000
		};
		if (pinnedIp) {
			options.lookup = (hostname, opts, callback) => callback(null, pinnedIp, 4);
			options.servername = target.hostname;
		}
		const req = httpsRequest(options, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => resolve({ ok: res.statusCode === 200 && /"code"\s*:\s*"(0{10}|0)"/.test(text), status: res.statusCode, body: text.slice(0, 200) }));
		});
		req.on("error", (error) => resolve({ ok: false, status: 0, body: String(error?.message ?? error) }));
		req.on("timeout", () => { try { req.destroy(); } catch { /* 已经断了 */ } resolve({ ok: false, status: 0, body: "timeout" }); });
		req.end(body);
	});
}

const authCode = resolveAuthCode();
const reply = (obj) => {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
	process.exit(obj.ok ? 0 : 1);
};

if (!authCode) reply({ ok: false, status: 0, body: "找不到 authCode（~/.dsh/profiles/web/cordis.patch.yml）" });
if (!finalContent) reply({ ok: false, status: 0, body: "缺少 --content（或 --template）" });

const sec = Math.floor(Date.now() / 1000);
const payload = {
	data: {
		authCode,
		msgContent: [{
			msgId: `dsh_alert_${sec}_${process.pid}`,
			scheduleTaskId: scheduleId,
			scheduleTaskName: finalName,
			summary: finalName,
			result: finalResult,
			content: finalContent,
			source: "OpenClaw",
			taskFinishTime: sec
		}]
	}
};

/**
 * 第二条传输：fetch（undici）。为什么两条都要：2026-10-02 晚上同一个端点出现
 * "同一分钟内 https.request 404、dsh 里的 fetch 工具却 200"，而 09-30 又反过来。
 * 告警路不该赌哪条今天好使，两条都试。
 */
async function postFetch(payload) {
	try {
		const response = await fetch(PUSH_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				"x-trace-id": `task-push-${new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14)}`
			},
			body: JSON.stringify(payload)
		});
		const text = await response.text();
		return { ok: response.status === 200 && /"code"\s*:\s*"(0{10}|0)"/.test(text), status: response.status, body: text.slice(0, 200) };
	} catch (error) {
		return { ok: false, status: 0, body: `fetch: ${String(error?.message ?? error)}` };
	}
}

/** 一轮投递：fetch → https.request → 逐个钉 A 记录（全都失败就返回最后一条结果）。 */
async function postRound(payload) {
	const viaFetch = await postFetch(payload);
	if (viaFetch.ok) return { ...viaFetch, body: `${viaFetch.body} (fetch)` };
	const viaHttps = await post(payload);
	if (viaHttps.ok) return { ...viaHttps, body: `${viaHttps.body} (https.request)` };
	let last = { ...viaHttps, body: `${viaHttps.body} | fetch: ${viaFetch.status} ${viaFetch.body.slice(0, 60)}` };
	try {
		const { lookup } = await import("node:dns/promises");
		const addresses = await lookup(new URL(PUSH_URL).hostname, { all: true });
		for (const item of addresses) {
			const pinned = await post(payload, item.address);
			if (pinned.ok) return { ...pinned, body: `${pinned.body} (pinned ${item.address})` };
			last = { ...last, body: `${last.body} | pinned ${item.address}: ${pinned.status}` };
		}
	} catch {
		// 解析不了就只靠下一次重试
	}
	return last;
}

let last = { ok: false, status: 0, body: "未尝试" };
// 端点有"坏窗口"（同一份字节，10:36:50 起连续 404、10:38 同样字节立刻 200）。告警虽然不急，
// 但绝不能在窗口里丢掉，所以退避重试 6 轮：5/10/20/30/60 秒（约 2 分钟）。
const backoff = [5000, 10000, 20000, 30000, 60000];
for (let attempt = 1; attempt <= 6; attempt += 1) {
	last = await postRound(payload);
	if (last.ok) break;
	if (attempt <= backoff.length) await new Promise((resolve) => setTimeout(resolve, backoff[attempt - 1]));
}
reply(last);
