import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
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
	[".webmanifest", "application/manifest+json"],
]);

function sendText(res, statusCode, body) {
	res.writeHead(statusCode, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
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
		"X-Content-Type-Options": "nosniff",
	});
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(filePath).pipe(res);
}

const httpServer = createServer((req, res) => {
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
