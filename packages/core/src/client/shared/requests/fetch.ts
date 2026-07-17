import { ScramjetClient } from "@client/index";
import {
	decodeOriginalUrlHeader,
	isOriginalUrlHeader,
	originalUrlHeaderName,
	unrewriteResponseHeader,
} from "./xmlhttprequest";
import { _Headers, String } from "@/shared/snapshot";

/**
 * Capture the page's intended `init.mode` / `init.credentials` and forward
 * them to `rewriteUrl` so they get stamped onto the proxy URL as `sj$mode` /
 * `sj$cred`. The service-side handler reads those back when computing
 * Sec-Fetch-Mode / Sec-Fetch-Storage-Access, since `event.request.mode` and
 * `event.request.credentials` from the SW are derived against the rewritten
 * same-origin URL and don't reflect the page's actual intent.
 */
function rewriteUrlOptionsForFetch(init: RequestInit | undefined) {
	const credentials = init?.credentials;
	return {
		// `fetch()` and `new Request()` both default mode to "cors" per spec.
		mode: init?.mode ?? "cors",
		// The default credentials mode for fetch()/Request is "same-origin".
		// Stamp it explicitly because the service worker only sees the rewritten
		// proxy URL, where same-origin/cross-origin relationships are distorted.
		credentials:
			credentials === "include" ||
			credentials === "same-origin" ||
			credentials === "omit"
				? credentials
				: "same-origin",
	};
}

export default function (client: ScramjetClient) {
	client.Proxy("fetch", {
		apply(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(
				url,
				rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
			);
		},
	});

	client.Proxy("Request", {
		construct(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(
				url,
				rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
			);
		},
	});

	client.Trap(["Request.prototype.url", "Response.prototype.url"], {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	// TODO: this needs to be only for response objects created from a fetch
	client.Trap("Response.prototype.headers", {
		get(ctx) {
			const headers = ctx.get() as Headers;
			const newHeaders = new _Headers();

			for (const [key, value] of headers.entries()) {
				if (isOriginalUrlHeader(key)) continue;

				const original = headers.get(originalUrlHeaderName(key));
				newHeaders.append(
					key,
					original === null
						? unrewriteResponseHeader(key, value, client.context)
						: decodeOriginalUrlHeader(original)
				);
			}

			return newHeaders;
		},
	});
}
