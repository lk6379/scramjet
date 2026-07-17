import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, self: GlobalThis) {
	client.Proxy("CustomElementRegistry.prototype.define", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (
				client.url.hostname !== "github.com" ||
				name !== "toggle-switch"
			) {
				return;
			}

			if (
				client.natives.call(
					"CustomElementRegistry.prototype.get",
					self.customElements,
					name
				)
			) {
				self.console.warn(
					`[scramjet] ignored duplicate custom element definition: ${name}`
				);
				return ctx.return(undefined);
			}
		},
	});
}
