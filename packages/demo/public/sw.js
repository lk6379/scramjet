importScripts("/controller/controller.sw.js");

addEventListener("message", (e) => {
	if (e.data?.type === "scramjet:claim-clients") {
		e.waitUntil(clients.claim());
	}
});

addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) {
		e.respondWith($scramjetController.route(e));
	}
});
