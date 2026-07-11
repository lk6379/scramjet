/* eslint-disable scramjet-core/no-globals, scramjet-core/no-instanceof -- The sync bridge serializes trusted internal data and explicitly uses constructors from the proxied page realm. */
import { ScramjetContext } from "@/shared";
import { unrewriteUrl } from "@rewriters/url";
import { ScramjetClient } from "@client/index";

const SYNC_XHR_ENDPOINT = "/__scramjet_sync_xhr__";
const MAX_SYNC_XHR_REDIRECTS = 10;

type SyncXhrBridgeResponse = {
	status: number;
	statusText: string;
	responseUrl: string;
	headers: Array<[string, string]>;
	body: string;
	setCookies: string[];
};

function findHeader(headers: Record<string, string>, name: string) {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) return headers[key];
	}
	return undefined;
}

function setHeaderIfMissing(
	headers: Record<string, string>,
	name: string,
	value: string
) {
	if (findHeader(headers, name) === undefined) headers[name] = value;
}

function deleteHeader(headers: Record<string, string>, name: string) {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) delete headers[key];
	}
}

function bytesToBase64(client: ScramjetClient, bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize)
		);
	}
	return client.natives.call("btoa", null, binary);
}

function base64ToBytes(client: ScramjetClient, value: string) {
	const binary = client.natives.call("atob", null, value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encodeRequestBody(
	client: ScramjetClient,
	self: Self,
	body: XMLHttpRequestBodyInit | Document | null
) {
	if (body === null || body === undefined) return null;

	if (self.Document && body instanceof self.Document) {
		body = new self.XMLSerializer().serializeToString(body);
	} else if (self.URLSearchParams && body instanceof self.URLSearchParams) {
		body = body.toString();
	}

	if (typeof body === "string") {
		return bytesToBase64(client, new self.TextEncoder().encode(body));
	}
	if (body instanceof self.ArrayBuffer) {
		return bytesToBase64(client, new Uint8Array(body));
	}
	if (self.ArrayBuffer.isView(body)) {
		return bytesToBase64(
			client,
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
		);
	}

	throw new TypeError(
		"Synchronous XMLHttpRequest only supports string and binary request bodies"
	);
}

export default function (client: ScramjetClient, self: Self) {
	const ARGS = Symbol("xhr original args");
	const ORIGINAL_URL = Symbol("xhr original url");
	const HEADERS = Symbol("xhr headers");

	client.Proxy("XMLHttpRequest.prototype.open", {
		apply(ctx) {
			if (ctx.args[1]) {
				ctx.this[ORIGINAL_URL] = new self.URL(
					String(ctx.args[1]),
					client.url
				).href;
				ctx.args[1] = client.rewriteUrl(ctx.args[1]);
			}
			if (ctx.args[2] === undefined) ctx.args[2] = true;
			ctx.this[ARGS] = ctx.args;
		}
	});

	client.Proxy("XMLHttpRequest.prototype.setRequestHeader", {
		apply(ctx) {
			const headers = ctx.this[HEADERS] || (ctx.this[HEADERS] = {});
			headers[ctx.args[0]] = ctx.args[1];
		}
	});

	client.Proxy("XMLHttpRequest.prototype.send", {
		apply(ctx) {
			const args = ctx.this[ARGS];
			if (!args || args[2]) return;

			if (!client.flagEnabled("syncxhr")) {
				console.warn("ignoring request - sync xhr disabled in flags");
				return ctx.return(undefined);
			}

			let requestUrl = ctx.this[ORIGINAL_URL] as string;
			let method = String(args[0]).toUpperCase();
			let encodedBody = encodeRequestBody(client, self, ctx.args[0]);
			const requestHeaders: Record<string, string> = {
				...(ctx.this[HEADERS] || {})
			};
			setHeaderIfMissing(requestHeaders, "Accept", "*/*");
			setHeaderIfMissing(requestHeaders, "Referer", client.url.href);
			setHeaderIfMissing(
				requestHeaders,
				"User-Agent",
				self.navigator.userAgent
			);
			if (method !== "GET" && method !== "HEAD") {
				setHeaderIfMissing(requestHeaders, "Origin", client.url.origin);
			}

			const bridgeUrl = new self.URL(SYNC_XHR_ENDPOINT, client.context.prefix)
				.href;
			let result: SyncXhrBridgeResponse | undefined;

			for (
				let redirects = 0;
				redirects <= MAX_SYNC_XHR_REDIRECTS;
				redirects++
			) {
				const remoteUrl = new self.URL(requestUrl);
				deleteHeader(requestHeaders, "Cookie");
				const cookies = client.context.cookieJar.getCookies(remoteUrl, false);
				if (cookies) requestHeaders.Cookie = cookies;

				const bridge = client.natives.construct("XMLHttpRequest");
				client.natives.call(
					"XMLHttpRequest.prototype.open",
					bridge,
					"POST",
					bridgeUrl,
					false
				);
				client.natives.call(
					"XMLHttpRequest.prototype.setRequestHeader",
					bridge,
					"Content-Type",
					"application/json"
				);
				client.natives.call(
					"XMLHttpRequest.prototype.send",
					bridge,
					JSON.stringify({
						url: requestUrl,
						method,
						headers: requestHeaders,
						body: encodedBody
					})
				);

				if (bridge.status !== 200) {
					throw new Error(
						bridge.responseText ||
							`Synchronous XMLHttpRequest bridge failed (${bridge.status})`
					);
				}
				result = JSON.parse(bridge.responseText) as SyncXhrBridgeResponse;

				if (result.setCookies.length) {
					const cookieUrl = new self.URL(result.responseUrl || requestUrl);
					const entries = result.setCookies.map((cookie) => ({
						url: cookieUrl,
						cookie
					}));
					for (const entry of entries) {
						client.context.cookieJar.setCookies(entry.cookie, entry.url);
					}
					void client.init.sendSetCookie(entries);
				}

				const location = result.headers.find(
					([name]) => name.toLowerCase() === "location"
				)?.[1];
				if (location && [301, 302, 303, 307, 308].includes(result.status)) {
					if (redirects === MAX_SYNC_XHR_REDIRECTS) {
						throw new Error("Too many synchronous XMLHttpRequest redirects");
					}
					const previousOrigin = remoteUrl.origin;
					requestUrl = new self.URL(location, remoteUrl).href;
					if (new self.URL(requestUrl).origin !== previousOrigin) {
						deleteHeader(requestHeaders, "Authorization");
					}
					if (
						result.status === 303 ||
						((result.status === 301 || result.status === 302) &&
							method === "POST")
					) {
						method = "GET";
						encodedBody = null;
						deleteHeader(requestHeaders, "Content-Type");
						deleteHeader(requestHeaders, "Content-Length");
					}
					continue;
				}

				break;
			}

			if (!result)
				throw new Error("Synchronous XMLHttpRequest returned no data");

			const bodyBytes = base64ToBytes(client, result.body);
			const responseText = new self.TextDecoder().decode(bodyBytes);
			const headers = result.headers
				.map(([name, value]) => `${name}: ${value}`)
				.join("\r\n");

			client.RawTrap(ctx.this, "readyState", {
				get() {
					return 4;
				}
			});
			client.RawTrap(ctx.this, "status", {
				get() {
					return result!.status;
				}
			});
			client.RawTrap(ctx.this, "statusText", {
				get() {
					return result!.statusText;
				}
			});
			client.RawTrap(ctx.this, "responseURL", {
				get() {
					return result!.responseUrl;
				}
			});
			client.RawTrap(ctx.this, "responseText", {
				get() {
					return responseText;
				}
			});
			client.RawTrap(ctx.this, "response", {
				get() {
					if (ctx.this.responseType === "arraybuffer") {
						return bodyBytes.buffer;
					}
					if (ctx.this.responseType === "json") {
						return responseText ? JSON.parse(responseText) : null;
					}
					if (ctx.this.responseType === "blob") {
						return new self.Blob([bodyBytes]);
					}
					return responseText;
				}
			});
			client.RawTrap(ctx.this, "responseXML", {
				get() {
					return new self.DOMParser().parseFromString(responseText, "text/xml");
				}
			});
			client.RawTrap(ctx.this, "getAllResponseHeaders", {
				get() {
					return () => headers;
				}
			});
			client.RawTrap(ctx.this, "getResponseHeader", {
				get() {
					return (header: string) => {
						const target = header.toLowerCase();
						return (
							result!.headers.find(
								([name]) => name.toLowerCase() === target
							)?.[1] ?? null
						);
					};
				}
			});

			ctx.return(undefined);
		}
	});

	client.Trap("XMLHttpRequest.prototype.responseURL", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		}
	});

	client.Proxy("XMLHttpRequest.prototype.getAllResponseHeaders", {
		apply(ctx) {
			const headerstring = ctx.fn.call(ctx.this) as string;
			if (!headerstring) return headerstring;
			const headers = headerstring.split("\r\n");

			for (const [i, header] of headers.entries()) {
				if (header.toLowerCase().startsWith("link:")) {
					headers[i] = `Link: ${unrewriteLinkHeader(
						header.slice(5).trim(),
						client.context
					)}`;
				}
			}

			ctx.return(headers.join("\r\n"));
		}
	});
	client.Proxy("XMLHttpRequest.prototype.getResponseHeader", {
		apply(ctx) {
			const header = ctx.fn.call(ctx.this, ctx.args[0]) as string | null;
			if (!header) return header;
			if (ctx.args[0].toLowerCase() === "link") {
				ctx.return(unrewriteLinkHeader(header, client.context));
			}
		}
	});
}

export function unrewriteLinkHeader(header: string, context: ScramjetContext) {
	return header.replace(
		/<([^>]+)>/gi,
		(_match, p1) => `<${unrewriteUrl(p1, context)}>`
	);
}
