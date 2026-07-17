import { BareResponse } from "@mercuryworkshop/scramjet";
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

const SERVER_FETCH_ENDPOINT = "/__scramjet_fetch__";
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
type RawHeaders = [string, string][];

type ServerFetchBridgeResponse = {
	status: number;
	statusText: string;
	responseUrl: string;
	headers: RawHeaders;
	body: string;
	setCookies: string[];
};

function isGithubMobileTwoFactorRequest(url: URL): boolean {
	return (
		url.hostname === "github.com" &&
		(url.pathname === "/sessions/two-factor/mobile" ||
			url.pathname === "/sessions/two-factor/mobile_poll")
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

async function bodyToBase64(body: BodyInit | null | undefined) {
	if (body === null || body === undefined) return undefined;

	if (typeof body === "string") {
		return bytesToBase64(new TextEncoder().encode(body));
	}
	if (body instanceof ArrayBuffer) {
		return bytesToBase64(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return bytesToBase64(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
		);
	}
	if (body instanceof Blob) {
		return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
	}

	// The service worker buffers API-like POST bodies before they reach the
	// controller, so this path should not be needed for GitHub's mobile 2FA poll.
	// If it ever is, leave the request on the normal transport rather than
	// risking a partially-consumed stream.
	return undefined;
}

function headersFromRawHeaders(rawHeaders: RawHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of rawHeaders) {
		try {
			headers.append(name, value);
		} catch {
			// Ignore invalid upstream headers; Scramjet's normal transport does the
			// same kind of best-effort conversion before exposing a Response.
		}
	}
	return headers;
}

function findHeader(headers: Record<string, string>, name: string) {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) return headers[key];
	}
	return undefined;
}

function buildBridgeRequestHeaders(rawHeaders: RawHeaders) {
	const headers = Object.fromEntries(rawHeaders);
	if (findHeader(headers, "User-Agent") === undefined) {
		headers["User-Agent"] = navigator.userAgent;
	}
	if (findHeader(headers, "Accept-Language") === undefined) {
		headers["Accept-Language"] = navigator.languages
			.map((language, index) => {
				if (index === 0) return language;
				const quality = Math.max(0.1, 1 - index * 0.1).toFixed(1);
				return `${language};q=${quality}`;
			})
			.join(",");
	}
	if (findHeader(headers, "Priority") === undefined) {
		headers.Priority = "u=1, i";
	}
	return headers;
}

function makeBareResponse(
	bridgeResponse: ServerFetchBridgeResponse
): BareResponse {
	const body = NULL_BODY_STATUSES.has(bridgeResponse.status)
		? null
		: base64ToArrayBuffer(bridgeResponse.body);
	const bareResponse = BareResponse.fromNativeResponse(
		new Response(body, {
			status: bridgeResponse.status,
			statusText: bridgeResponse.statusText,
			headers: headersFromRawHeaders(bridgeResponse.headers),
		})
	);

	bareResponse.rawHeaders = bridgeResponse.headers;
	bareResponse.url = bridgeResponse.responseUrl;

	return bareResponse;
}

/**
 * GitHub's mobile 2FA page rotates the session cookie before its polling script
 * starts. Route both that page and its poll endpoint through the same bridge so
 * the new session cookie is stored before the rewritten HTML can issue its first
 * credentialed multipart POST.
 */
export class ServerFetchFallbackPlugin extends ManagedPlugin {
	constructor() {
		super("server-fetch-fallback", []);
	}

	install(frame: Frame): void {
		super.install(frame);

		this.tap(frame.hooks.fetch.request, async (ctx, props) => {
			if (props.earlyResponse) return;
			if (!isGithubMobileTwoFactorRequest(ctx.parsed.url)) return;

			const body = await bodyToBase64(props.init.body);
			if (
				props.init.body !== null &&
				props.init.body !== undefined &&
				body === undefined
			) {
				return;
			}

			try {
				const response = await fetch(SERVER_FETCH_ENDPOINT, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						url: props.url.href,
						method: props.init.method,
						headers: buildBridgeRequestHeaders(props.init.headers ?? []),
						body,
					}),
				});

				if (!response.ok) {
					throw new Error(
						`server fetch bridge failed with HTTP ${response.status}`
					);
				}

				const bridgeResponse =
					(await response.json()) as ServerFetchBridgeResponse;
				if (bridgeResponse.setCookies.length) {
					const cookieUrl = new URL(
						bridgeResponse.responseUrl || props.url.href
					);
					const entries = bridgeResponse.setCookies.map((cookie) => ({
						url: cookieUrl,
						cookie,
					}));
					for (const entry of entries) {
						frame.controller.cookieJar.setCookies(entry.cookie, entry.url);
					}
					await frame.controller.persistCookies();
					await frame.controller.propagateCookieSync(
						entries.map((entry) => ({
							url: entry.url.href,
							cookie: entry.cookie,
						})),
						{ destination: ctx.parsed.destination }
					);
				}

				props.earlyResponse = makeBareResponse(bridgeResponse);
			} catch (error) {
				console.warn(
					"[scramjet] server fetch fallback failed, using configured transport:",
					error
				);
			}
		});
	}
}
