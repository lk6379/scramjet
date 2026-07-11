import { createReadStream } from "node:fs";
import { lookup } from "node:dns/promises";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const host = process.env.HOST || "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "4141", 10);
const publicRoot = resolve(
	process.env.PUBLIC_DIR || fileURLToPath(new URL("./public", import.meta.url))
);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new TypeError(`Invalid PORT: ${process.env.PORT}`);
}

const allowPrivateNetworks = process.env.ALLOW_PRIVATE_NETWORKS === "true";
const syncXhrEndpoint = "/__scramjet_sync_xhr__";
const maxSyncXhrPayload = 20 * 1024 * 1024;
const maxSyncXhrResponse = 16 * 1024 * 1024;
wisp.options.allow_private_ips = allowPrivateNetworks;
wisp.options.allow_loopback_ips = allowPrivateNetworks;

const contentTypes = new Map([
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".wasm", "application/wasm"],
	[".webmanifest", "application/manifest+json"]
]);

function sendText(res, statusCode, body) {
	res.writeHead(statusCode, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": Buffer.byteLength(body)
	});
	res.end(body);
}

function sendJson(res, statusCode, value) {
	const body = JSON.stringify(value);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	res.end(body);
}

function isPrivateIpAddress(address) {
	const normalized = address.toLowerCase().split("%")[0];
	if (normalized.startsWith("::ffff:")) {
		return isPrivateIpAddress(normalized.slice(7));
	}

	if (isIP(normalized) === 4) {
		const [a, b] = normalized.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}

	if (isIP(normalized) === 6) {
		return (
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith("ff")
		);
	}

	return true;
}

async function assertAllowedTarget(url) {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new TypeError("Only HTTP and HTTPS targets are supported");
	}
	if (allowPrivateNetworks) return;

	const addresses = isIP(url.hostname)
		? [{ address: url.hostname }]
		: await lookup(url.hostname, { all: true, verbatim: true });
	if (
		!addresses.length ||
		addresses.some(({ address }) => isPrivateIpAddress(address))
	) {
		throw new TypeError("Private network targets are disabled");
	}
}

async function readJsonBody(req) {
	const chunks = [];
	let length = 0;
	for await (const chunk of req) {
		length += chunk.length;
		if (length > maxSyncXhrPayload) {
			throw new RangeError("Synchronous XMLHttpRequest payload is too large");
		}
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleSyncXhr(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { Allow: "POST" });
		res.end();
		return;
	}

	try {
		const payload = await readJsonBody(req);
		const target = new URL(payload.url);
		await assertAllowedTarget(target);

		const method = String(payload.method || "GET").toUpperCase();
		const headers = new Headers();
		for (const [name, value] of Object.entries(payload.headers || {})) {
			if (typeof value !== "string") continue;
			if (
				[
					"connection",
					"content-length",
					"host",
					"transfer-encoding",
					"upgrade"
				].includes(name.toLowerCase())
			) {
				continue;
			}
			headers.set(name, value);
		}

		const body = payload.body ? Buffer.from(payload.body, "base64") : undefined;
		const response = await fetch(target, {
			method,
			headers,
			body: method === "GET" || method === "HEAD" ? undefined : body,
			redirect: "manual",
			signal: AbortSignal.timeout(30_000)
		});
		const responseBuffer = Buffer.from(await response.arrayBuffer());
		if (responseBuffer.length > maxSyncXhrResponse) {
			throw new RangeError("Synchronous XMLHttpRequest response is too large");
		}

		const responseHeaders = [];
		for (const [name, value] of response.headers) {
			if (
				[
					"content-encoding",
					"content-length",
					"set-cookie",
					"transfer-encoding"
				].includes(name.toLowerCase())
			) {
				continue;
			}
			responseHeaders.push([name, value]);
		}
		const setCookies =
			typeof response.headers.getSetCookie === "function"
				? response.headers.getSetCookie()
				: [];

		sendJson(res, 200, {
			status: response.status,
			statusText: response.statusText,
			responseUrl: response.url || target.href,
			headers: responseHeaders,
			body: responseBuffer.toString("base64"),
			setCookies
		});
	} catch (error) {
		const statusCode =
			error instanceof TypeError || error instanceof RangeError ? 400 : 502;
		sendJson(res, statusCode, {
			error:
				error instanceof Error ? error.message : "Synchronous request failed"
		});
	}
}

async function serveStatic(req, res) {
	if (req.url === "/healthz") {
		sendText(res, 200, "ok\n");
		return;
	}

	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { Allow: "GET, HEAD" });
		res.end();
		return;
	}

	let pathname;
	try {
		pathname = decodeURIComponent(
			new URL(req.url || "/", "http://localhost").pathname
		);
	} catch {
		sendText(res, 400, "Bad request\n");
		return;
	}

	const relativePath = normalize(pathname).replace(/^([/\\])+/, "");
	let filePath = resolve(publicRoot, relativePath || "index.html");
	if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
		sendText(res, 403, "Forbidden\n");
		return;
	}

	let fileStat = await stat(filePath).catch(() => null);
	if (fileStat?.isDirectory()) {
		filePath = join(filePath, "index.html");
		fileStat = await stat(filePath).catch(() => null);
	}

	if (!fileStat?.isFile()) {
		sendText(res, 404, "Not found\n");
		return;
	}

	const extension = extname(filePath).toLowerCase();
	const immutable = /[/\\]assets[/\\]/.test(filePath);
	res.writeHead(200, {
		"Content-Type": contentTypes.get(extension) || "application/octet-stream",
		"Content-Length": fileStat.size,
		"Cache-Control": immutable
			? "public, max-age=31536000, immutable"
			: "no-cache",
		"X-Content-Type-Options": "nosniff"
	});
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(filePath).pipe(res);
}

const httpServer = createServer((req, res) => {
	if (req.url === syncXhrEndpoint) {
		handleSyncXhr(req, res).catch((error) => {
			console.error(error);
			if (!res.headersSent) sendText(res, 500, "Internal server error\n");
			else res.destroy();
		});
		return;
	}

	serveStatic(req, res).catch((error) => {
		console.error(error);
		if (!res.headersSent) sendText(res, 500, "Internal server error\n");
		else res.destroy();
	});
});

httpServer.on("upgrade", (req, socket, head) => {
	if (req.url?.startsWith("/wisp/")) {
		wisp.routeRequest(req, socket, head);
		return;
	}
	socket.destroy();
});

httpServer.listen(port, host, () => {
	console.log(`Scramjet listening on http://${host}:${port}`);
	console.log(
		`Private network proxying: ${allowPrivateNetworks ? "enabled" : "disabled"}`
	);
});

function shutdown(signal) {
	console.log(`${signal} received, shutting down`);
	httpServer.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
