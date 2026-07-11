import LoadInterstitial from "./components/LoadInterstitial";
import App from "./App";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev } from "@mercuryworkshop/scramjet";
import { Controller } from "@mercuryworkshop/scramjet-controller";
import { HttpCachePlugin } from "@mercuryworkshop/scramjet-utils";
import { demoSettingsStore } from "./store";

let app = document.getElementById("app")!;

let controller: InstanceType<typeof Controller>;
const cachePlugin = new HttpCachePlugin();

export function getTransport(): LibcurlClient | EpoxyClient {
	const wispUrl = demoSettingsStore.wispUrl;
	switch (demoSettingsStore.transport) {
		case "epoxy":
			return new EpoxyClient({ wisp: wispUrl });
		case "libcurl":
		default:
			return new LibcurlClient({ wisp: wispUrl });
	}
}

async function waitForController(
	registration: ServiceWorkerRegistration,
	timeoutMs = 10000
): Promise<ServiceWorker> {
	if (navigator.serviceWorker.controller) {
		return navigator.serviceWorker.controller;
	}

	const readyRegistration = await Promise.race([
		navigator.serviceWorker.ready,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("Service worker activation timed out")),
				timeoutMs
			)
		)
	]);
	const activeWorker = registration.active ?? readyRegistration.active;
	if (!activeWorker) {
		throw new Error("No active service worker available");
	}

	return new Promise<ServiceWorker>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		const cleanup = () => {
			clearTimeout(timeout);
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onControllerChange
			);
		};
		const finish = () => {
			const controllingWorker = navigator.serviceWorker.controller;
			if (!controllingWorker) return;
			cleanup();
			resolve(controllingWorker);
		};
		const onControllerChange = () => finish();

		navigator.serviceWorker.addEventListener(
			"controllerchange",
			onControllerChange
		);
		timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Service worker did not take control of this page"));
		}, timeoutMs);

		// An already-active worker does not automatically claim a page that was
		// loaded before it. Ask it to claim this client, then wait for the actual
		// controllerchange event before initializing Scramjet.
		activeWorker.postMessage({ type: "scramjet:claim-clients" });
		finish();
	});
}

async function init() {
	const interstitial: any = (
		<LoadInterstitial status={"Loading"}></LoadInterstitial>
	);
	document.body.append(interstitial);
	interstitial.showModal();

	try {
		const registration = await navigator.serviceWorker.register("./sw.js");

		// Non-blocking progress updates on state transitions.
		const updateStatus = (sw: ServiceWorker | null) => {
			if (!sw) return;
			const set = (msg: string) => (interstitial.$.state.status = msg);
			const apply = () => {
				switch (sw.state) {
					case "installing":
						set("Installing service worker...");
						break;
					case "installed":
						set("Service worker installed, waiting to activate...");
						break;
					case "activating":
						set("Activating service worker...");
						break;
					case "activated":
						set("Service worker activated");
						break;
					case "redundant":
						set("Service worker became redundant");
						break;
				}
			};
			apply();
			sw.addEventListener("statechange", apply);
		};

		updateStatus(registration.installing ?? registration.waiting ?? null);

		// The proxy routes only work after the current page is controlled. Merely
		// having an active worker is not sufficient.
		interstitial.$.state.status =
			"Waiting for service worker to take control...";
		const readySw = await waitForController(registration, 10000);
		interstitial.$.state.status =
			"Service worker ready, waiting for controller init";
		controller = new Controller({
			serviceworker: readySw,
			transport: getTransport(),
			scramjetConfig: defaultConfigDev,
		});
		await controller.wait();
		console.log(controller);
		interstitial.$.state.status = "Controller initialized";
		interstitial.close();
	} catch (e) {
		console.error("Error during service worker registration:", e);
		// Always close the modal on error to prevent hanging UI.
		try {
			interstitial.close();
		} catch {}
		app.innerText =
			"Failed to register service worker. Check console for details.";
	}
}

async function mount() {
	try {
		const root = <App />;
		app.replaceWith(root);
	} catch (e) {
		let err = e as any;
		app.replaceWith(
			document.createTextNode(
				`Error mounting: ${"message" in err ? err.message : err}`
			)
		);
		console.error(err);
		throw e;
	}
}

init().then(() => mount());
export { controller, cachePlugin };
