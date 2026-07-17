import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { connect as http2Connect } from "node:http2";
import { lookup } from "node:dns/promises";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
const serverFetchEndpoint = "/__scramjet_fetch__";
const browserFetchScript = fileURLToPath(
	new URL("./browser_fetch.py", import.meta.url)
);
const pythonExecutable = process.env.PYTHON || "python3";
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

function rawHeaderValue(headers, name) {
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) return value;
	}
	return undefined;
}

function setHeaderIfMissing(headers, name, value) {
	if (rawHeaderValue(headers, name) === undefined) {
		headers[name] = value;
	}
}

function setHeader(headers, name, value) {
	if (typeof value !== "string" || !value) return;
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) {
			headers[key] = value;
			return;
		}
	}
	headers[name] = value;
}

function responseHeadersFromRaw(rawHeaders) {
	const headers = [];
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		const value = rawHeaders[i + 1];
		if (typeof name !== "string" || typeof value !== "string") continue;
		if (
			[
				"content-length",
				"set-cookie",
				"transfer-encoding"
			].includes(name.toLowerCase())
		) {
			continue;
		}
		headers.push([name, value]);
	}
	return headers;
}

function setCookiesFromRaw(rawHeaders) {
	const cookies = [];
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		const value = rawHeaders[i + 1];
		if (
			typeof name === "string" &&
			typeof value === "string" &&
			name.toLowerCase() === "set-cookie"
		) {
			cookies.push(value);
		}
	}
	return cookies;
}

function responseHeadersFromHttp2(headers) {
	const responseHeaders = [];
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(":")) continue;
		if (
			[
				"content-length",
				"set-cookie",
				"transfer-encoding"
			].includes(name.toLowerCase())
		) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string") responseHeaders.push([name, entry]);
			}
		} else if (typeof value === "string") {
			responseHeaders.push([name, value]);
		}
	}
	return responseHeaders;
}

function setCookiesFromHttp2(headers) {
	const setCookie = headers["set-cookie"];
	if (Array.isArray(setCookie)) return setCookie;
	if (typeof setCookie === "string") return [setCookie];
	return [];
}

function http2RequestHeaders(target, method, headers) {
	const out = {
		":method": method,
		":scheme": target.protocol.slice(0, -1),
		":authority": target.host,
		":path": `${target.pathname}${target.search}`,
	};

	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase();
		if (
			[
				"connection",
				"host",
				"keep-alive",
				"proxy-connection",
				"transfer-encoding",
				"upgrade"
			].includes(lowerName)
		) {
			continue;
		}
		out[lowerName] = value;
	}

	return out;
}

function requestWithHttp2(target, { method, headers, body }) {
	return new Promise((resolve, reject) => {
		const client = http2Connect(target.origin, {
			ALPNProtocols: ["h2"],
		});
		let settled = false;

		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			client.close();
			callback(value);
		};

		client.setTimeout(30_000, () => {
			finish(reject, new Error("HTTP/2 server fetch timed out"));
		});
		client.on("error", (error) => finish(reject, error));

		const stream = client.request(http2RequestHeaders(target, method, headers), {
			endStream: !body || method === "GET" || method === "HEAD",
		});
		const chunks = [];
		let length = 0;
		let responseHeaders = {};

		stream.setTimeout(30_000, () => {
			stream.close();
			finish(reject, new Error("HTTP/2 server fetch timed out"));
		});
		stream.on("response", (headers) => {
			responseHeaders = headers;
		});
		stream.on("data", (chunk) => {
			length += chunk.length;
			if (length > maxSyncXhrResponse) {
				stream.close();
				finish(reject, new RangeError("Server fetch response is too large"));
				return;
			}
			chunks.push(chunk);
		});
		stream.on("end", () => {
			finish(resolve, {
				status: Number(responseHeaders[":status"] || 0),
				statusText: "",
				headers: responseHeadersFromHttp2(responseHeaders),
				body: Buffer.concat(chunks),
				setCookies: setCookiesFromHttp2(responseHeaders),
			});
		});
		stream.on("error", (error) => finish(reject, error));

		if (body && method !== "GET" && method !== "HEAD") {
			stream.end(body);
		}
	});
}

function requestWithHttp1(target, { method, headers, body }) {
	return new Promise((resolve, reject) => {
		const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
		const req = requestImpl(
			target,
			{
				method,
				headers,
				timeout: 30_000,
				joinDuplicateHeaders: false,
			},
			(upstream) => {
				const chunks = [];
				let length = 0;
				upstream.on("data", (chunk) => {
					length += chunk.length;
					if (length > maxSyncXhrResponse) {
						upstream.destroy(
							new RangeError("Server fetch response is too large")
						);
						return;
					}
					chunks.push(chunk);
				});
				upstream.on("end", () => {
					resolve({
						status: upstream.statusCode || 0,
						statusText: upstream.statusMessage || "",
						headers: responseHeadersFromRaw(upstream.rawHeaders),
						body: Buffer.concat(chunks),
						setCookies: setCookiesFromRaw(upstream.rawHeaders)
					});
				});
			}
		);

		req.on("timeout", () => {
			req.destroy(new Error("Server fetch timed out"));
		});
		req.on("error", reject);
		if (body && method !== "GET" && method !== "HEAD") {
			req.write(body);
		}
		req.end();
	});
}

function isGithubMobileTwoFactorRequest(target) {
	return (
		target.protocol === "https:" &&
		target.hostname === "github.com" &&
		(target.pathname === "/sessions/two-factor/mobile" ||
			target.pathname === "/sessions/two-factor/mobile_poll")
	);
}

function requestWithBrowserImpersonation(target, { method, headers, body }) {
	return new Promise((resolve, reject) => {
		const child = spawn(pythonExecutable, [browserFetchScript], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		let stdoutLength = 0;
		let stderrLength = 0;
		let settled = false;

		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback(value);
		};

		const timeout = setTimeout(() => {
			child.kill();
			finish(reject, new Error("Browser fetch timed out"));
		}, 35_000);

		child.stdout.on("data", (chunk) => {
			stdoutLength += chunk.length;
			if (stdoutLength > maxSyncXhrResponse * 2) {
				child.kill();
				finish(reject, new RangeError("Browser fetch response is too large"));
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength <= 16 * 1024) stderr.push(chunk);
		});
		child.stdin.on("error", (error) => finish(reject, error));
		child.on("error", (error) => finish(reject, error));
		child.on("close", (code) => {
			if (settled) return;
			let result;
			try {
				result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
			} catch {
				const detail = Buffer.concat(stderr).toString("utf8").trim();
				finish(reject, new Error(detail || `Browser fetch exited with code ${code}`));
				return;
			}

			if (code !== 0 || result.error) {
				finish(reject, new Error(result.error || `Browser fetch exited with code ${code}`));
				return;
			}

			finish(resolve, {
				status: Number(result.status || 0),
				statusText: String(result.statusText || ""),
				headers: Array.isArray(result.headers) ? result.headers : [],
				body: Buffer.from(result.body || "", "base64"),
				setCookies: Array.isArray(result.setCookies) ? result.setCookies : [],
				responseUrl: String(result.responseUrl || target.href),
				transport: "browser-impersonation",
			});
		});

		child.stdin.end(
			JSON.stringify({
				url: target.href,
				method,
				headers,
				body: body?.toString("base64"),
			})
		);
	});
}

async function requestWithRawHeaders(target, options) {
	if (isGithubMobileTwoFactorRequest(target)) {
		try {
			return await requestWithBrowserImpersonation(target, options);
		} catch (error) {
			if (error instanceof RangeError) throw error;
			console.warn(
				`Browser-compatible fetch unavailable, falling back to Node HTTP/2: ${error instanceof Error ? error.message : error}`
			);
		}
	}
	if (target.protocol === "https:") {
		try {
			return await requestWithHttp2(target, options);
		} catch (error) {
			if (error instanceof RangeError) throw error;
			return requestWithHttp1(target, options);
		}
	}
	return requestWithHttp1(target, options);
}

async function handleServerFetch(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405, { Allow: "POST" });
		res.end();
		return;
	}

	try {
		const payload = await readJsonBody(req);
		const target = new URL(payload.url);
		if (!isGithubMobileTwoFactorRequest(target)) {
			sendJson(res, 403, {
				error: "Server fetch is restricted to GitHub mobile two-factor authentication"
			});
			return;
		}
		await assertAllowedTarget(target);

		const method = String(payload.method || "GET").toUpperCase();
		const expectedMethod = target.pathname.endsWith("/mobile_poll")
			? "POST"
			: "GET";
		if (method !== expectedMethod) {
			sendJson(res, 405, {
				error: `GitHub mobile two-factor endpoint requires ${expectedMethod}`
			});
			return;
		}
		const headers = {};
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
			headers[name] = value;
		}

		const body = payload.body ? Buffer.from(payload.body, "base64") : undefined;
		if (body && method !== "GET" && method !== "HEAD") {
			setHeaderIfMissing(headers, "Content-Length", String(body.length));
		}
		if (isGithubMobileTwoFactorRequest(target)) {
			setHeader(headers, "Accept-Language", req.headers["accept-language"]);
			setHeader(headers, "Accept-Encoding", req.headers["accept-encoding"]);
		} else {
			setHeaderIfMissing(headers, "Accept-Encoding", "identity");
		}

		const response = await requestWithRawHeaders(target, {
			method,
			headers,
			body
		});

		sendJson(res, 200, {
			status: response.status,
			statusText: response.statusText,
			responseUrl: response.responseUrl || target.href,
			headers: response.headers,
			body: response.body.toString("base64"),
			setCookies: response.setCookies,
			transport: response.transport || "node"
		});
	} catch (error) {
		const statusCode =
			error instanceof TypeError || error instanceof RangeError ? 400 : 502;
		sendJson(res, statusCode, {
			error: error instanceof Error ? error.message : "Server fetch failed"
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

	if (req.url === serverFetchEndpoint) {
		handleServerFetch(req, res).catch((error) => {
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
