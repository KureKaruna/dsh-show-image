window.__ModuleLoader__.load({
	id: "dsh-show-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		//#region caption styles
		const css = ".dsh-show-image-block{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:2px 0}.dsh-show-image-caption{max-width:520px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:12px;line-height:18px}";
		const styleTagId = "dsh-show-image/ShowImageBlock.module.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + styleTagId + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-show-image";
			tag.dataset.pluginCss = styleTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region ShowImage chat node view
		/**
		 * Renders one show-image node: the conversation package's own image
		 * gallery (via the routed renderMessageImages owner prop, which feeds the
		 * conversation.message.images slot and its lightbox), plus the optional
		 * caption under it.
		 */
		function ShowImageNodeView(props) {
			const data = props.node.data;
			if (data === void 0 || data.attachment === void 0) return null;
			const gallery = props.renderMessageImages({
				images: [{ attachment: data.attachment }],
				align: "start",
			});
			if (data.caption === "") return gallery;
			return React.createElement(
				"div",
				{ className: "dsh-show-image-block" },
				gallery,
				React.createElement("div", { className: "dsh-show-image-caption", title: data.path }, data.caption),
			);
		}
		//#endregion

		//#region dual-channel conversation definition
		const META_PRODUCER = "dsh-show-image";
		const PAYLOAD_MARK_OPEN = "<dsh-show-image-payload>";
		const PAYLOAD_MARK_CLOSE = "</dsh-show-image-payload>";

		/** Parse the enriched durable-log marker out of one code-dispatch content list. */
		function payloadFromContent(content) {
			if (!Array.isArray(content)) return null;
			for (const block of content) {
				if (block === null || block.type !== "text" || typeof block.text !== "string") continue;
				if (!block.text.startsWith(PAYLOAD_MARK_OPEN)) continue;
				const end = block.text.indexOf(PAYLOAD_MARK_CLOSE);
				if (end <= PAYLOAD_MARK_OPEN.length) continue;
				try {
					const payload = JSON.parse(block.text.slice(PAYLOAD_MARK_OPEN.length, end));
					if (payload !== null && typeof payload === "object" && payload.attachment !== void 0) return payload;
				} catch (_error) { /* malformed marker — ignore */ }
			}
			return null;
		}

		/**
		 * One marked result → one standalone gallery node. Two durable channels:
		 * top-level native calls persist the payload in tool/result meta; nested
		 * run_code sub-dispatches (this deployment's only invocation path) carry
		 * it in an enriched tool/code-dispatch log copy appended by the host
		 * plugin's tools/code-dispatch-log listener. Identity is the event seq,
		 * so replace/prepend/append ingestion rebuilds identically.
		 */
		const definition = {
			kind: "show-image",
			target: "chat",
			match: (event) => {
				if (event.type === "tool/result") {
					const meta = event.data !== void 0 ? event.data.meta : void 0;
					return meta !== void 0 && meta.producer === META_PRODUCER
						? { id: String(event.seq), role: "start" }
						: null;
				}
				if (event.type === "tool/code-dispatch") {
					const data = event.data;
					return data !== void 0
						&& data.name === "show_image"
						&& data.isError !== true
						&& payloadFromContent(data.content) !== null
						? { id: String(event.seq), role: "start" }
						: null;
				}
				return null;
			},
			start: (_context, match) => {
				if (match.event.type === "tool/result") {
					const meta = match.event.data.meta;
					return {
						path: typeof meta.path === "string" ? meta.path : "",
						caption: typeof meta.caption === "string" ? meta.caption : "",
						attachment: meta.attachment,
					};
				}
				const payload = payloadFromContent(match.event.data.content) ?? {};
				return {
					path: typeof payload.path === "string" ? payload.path : "",
					caption: typeof payload.caption === "string" ? payload.caption : "",
					attachment: payload.attachment,
				};
			},
			update: (context) => context.state,
			publication: () => "immediate",
			buildViewNode: (context) => {
				if (context.state === void 0 || context.state.attachment === void 0) return null;
				const startMatch = context.start ?? context.matches[0];
				return {
					key: context.key,
					kind: "show-image",
					id: context.id,
					target: "chat",
					anchorSeq: startMatch !== void 0 ? startMatch.event.seq : 0,
					location: startMatch !== void 0
						? (startMatch.location ?? { kind: "unresolved" })
						: { kind: "unresolved" },
					visibility: "visible",
					data: context.state,
				};
			},
		};
		//#endregion

		//#region client plugin apply
		const inject = ["conversationEvents", "slots"];

		function apply(ctx) {
			ctx.conversationEvents.register(definition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "show-image",
			}, ShowImageNodeView));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
