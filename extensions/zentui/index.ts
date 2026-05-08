import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@mariozechner/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type PolishedTuiConfig, colorize, ensureConfigExists, loadConfig } from "./config";
import { type GitStatusSummary, emptyGitStatus, readGitStatus } from "./git";
import { type RuntimeInfo, readRuntimeInfo } from "./runtime";
import { PolishedEditor, patchUserMessageComponent } from "./ui";

type FooterState = GitStatusSummary & {
	busy: boolean;
	modelLabel: string;
	providerLabel: string;
	contextLabel: string;
	tokenLabel: string;
	costLabel: string;
	runtime?: RuntimeInfo;
	idleSince?: number;
	metaLabel: string;
	thinkingLabel: string;
};

type UsageTotals = {
	input: number;
	output: number;
	cost: number;
};

type CodexQuotaDisplay = {
	fiveHourLeft?: number;
	sevenDayLeft?: number;
	resetText?: string;
};

type CodexStatusLimitWindow = {
	leftPercent?: number;
	usedPercent?: number;
	resetAt?: number;
};

type CodexStatusCache = {
	defaultLimit?: {
		primary?: CodexStatusLimitWindow;
		secondary?: CodexStatusLimitWindow;
	};
};

type FooterDataLike = {
	getExtensionStatuses?: () => ReadonlyMap<string, string>;
};

const CODEX_STATUS_CACHE_PATHS = [
	join(homedir(), ".cache", "pi-codex-status", "usage.json"),
	join(homedir(), ".cache", "pi-codex-usage", "usage.json"),
];

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";

	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
		multicodex: "MultiCodex",
	};

	return (
		known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
	);
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}

	return { input, output, cost };
}

function buildTokenLabel(totals: UsageTotals): string {
	return `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
}

function buildCostLabel(totals: UsageTotals): string {
	return `$${totals.cost.toFixed(3)}`;
}

function isCodexModel(ctx: ExtensionContext): boolean {
	const provider = ctx.model?.provider;
	const modelId = ctx.model?.id ?? "";
	return provider === "openai-codex" || provider === "multicodex" || /codex/i.test(modelId);
}

function normalizeRemainingPercent(window?: CodexStatusLimitWindow): number | undefined {
	if (!window) return undefined;
	if (typeof window.leftPercent === "number" && Number.isFinite(window.leftPercent)) {
		return Math.max(0, Math.min(100, window.leftPercent));
	}
	if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
		return Math.max(0, Math.min(100, 100 - window.usedPercent));
	}
	return undefined;
}

function formatResetCountdown(resetAtMs: number | undefined): string | undefined {
	if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs)) return undefined;
	const totalSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function readCodexStatusCache(): CodexQuotaDisplay | undefined {
	for (const cachePath of CODEX_STATUS_CACHE_PATHS) {
		try {
			if (!existsSync(cachePath)) continue;
			const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CodexStatusCache;
			const primary = parsed.defaultLimit?.primary;
			const secondary = parsed.defaultLimit?.secondary;
			const fiveHourLeft = normalizeRemainingPercent(primary);
			const sevenDayLeft = normalizeRemainingPercent(secondary);
			if (fiveHourLeft === undefined && sevenDayLeft === undefined) continue;
			const resetAtSeconds = secondary?.resetAt ?? primary?.resetAt;
			const resetAtMs = typeof resetAtSeconds === "number" ? resetAtSeconds * 1000 : undefined;
			return {
				fiveHourLeft,
				sevenDayLeft,
				resetText: formatResetCountdown(resetAtMs),
			};
		} catch {}
	}
	return undefined;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function remainingPercentFromMatch(match: RegExpMatchArray | null): number | undefined {
	if (!match) return undefined;
	const value = Math.max(0, Math.min(100, Number(match[1])));
	return match[2]?.toLowerCase() === "used" ? 100 - value : value;
}

function parseMulticodexFooterStatus(statusText: string): CodexQuotaDisplay | undefined {
	const plain = stripAnsi(statusText);
	const fiveHourMatch = plain.match(/5h:\s*(\d{1,3})%\s*(left|used)?/i);
	const sevenDayMatch = plain.match(/7d:\s*(\d{1,3})%\s*(left|used)?/i);
	const resetMatch = plain.match(/7d:[^↺]*↺([^\s)]+)/i) ?? plain.match(/↺([^\s)]+)/i);
	const fiveHourLeft = remainingPercentFromMatch(fiveHourMatch);
	const sevenDayLeft = remainingPercentFromMatch(sevenDayMatch);
	if (fiveHourLeft === undefined && sevenDayLeft === undefined) return undefined;
	return { fiveHourLeft, sevenDayLeft, resetText: resetMatch?.[1] };
}

function getCodexQuotaDisplay(footerData: FooterDataLike): CodexQuotaDisplay | undefined {
	const statuses = footerData.getExtensionStatuses?.();
	const multicodexStatus = statuses?.get("multicodex-usage");
	if (multicodexStatus) {
		const parsed = parseMulticodexFooterStatus(multicodexStatus);
		if (parsed) return parsed;
	}
	return readCodexStatusCache();
}

function getQuotaPercentColor(percent: number | undefined): string {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "dim";
	if (percent < 5) return "error";
	if (percent < 25) return "#ffaf00";
	if (percent < 50) return "warning";
	return "success";
}

function formatQuotaPercent(theme: Pick<Theme, "fg">, percent: number | undefined): string {
	if (typeof percent !== "number" || !Number.isFinite(percent)) {
		return colorize(theme, "dim", "--%");
	}
	return colorize(theme, getQuotaPercentColor(percent), `${Math.round(percent)}%`);
}

function formatCodexQuotaLabel(
	theme: Pick<Theme, "fg">,
	quota: CodexQuotaDisplay | undefined,
): string | undefined {
	if (!quota) return undefined;
	const parts = [
		`5h:${formatQuotaPercent(theme, quota.fiveHourLeft)}`,
		`7d:${formatQuotaPercent(theme, quota.sevenDayLeft)}`,
	];
	if (quota.resetText) parts.push(colorize(theme, "muted", `↺${quota.resetText}`));
	return parts.join(" ");
}

function buildContextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = ctx.model?.contextWindow ?? usage?.contextWindow;

	if (!usage || !contextWindow || contextWindow <= 0) return "--";

	const percent =
		usage.percent === null ? "?" : `${Math.max(0, Math.min(999, Math.round(usage.percent)))}%`;
	return `${percent}/${formatCount(contextWindow)}`;
}

function getRuntimeColorToken(runtime: RuntimeInfo | undefined): string {
	switch (runtime?.name) {
		case "nodejs":
			return "success";
		case "deno":
			return "syntaxType";
		case "bun":
			return "warning";
		case "python":
		case "java":
			return "warning";
		case "rust":
		case "ruby":
			return "error";
		case "golang":
			return "syntaxType";
		case "lua":
		case "php":
			return "accent";
		default:
			return "text";
	}
}

function formatRuntimeSegment(
	theme: Pick<Theme, "fg">,
	runtime: RuntimeInfo | undefined,
	mutedColor: string,
): string {
	if (!runtime) return "";
	const label = runtime.version ? `${runtime.symbol} ${runtime.version}` : runtime.symbol;
	return `${colorize(theme, mutedColor, "via")} ${colorize(theme, getRuntimeColorToken(runtime), label)}`;
}

function formatElapsed(sinceMs: number): string {
	const elapsed = Math.floor((Date.now() - sinceMs) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	const m = Math.floor(elapsed / 60);
	const s = elapsed % 60;
	if (m < 60) return `${m}m${s > 0 ? `${s}s` : ""}`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

function idleMinutes(sinceMs: number): number {
	return Math.floor((Date.now() - sinceMs) / 60000);
}

function buildMetaLabel(provider: string, model: string): string {
	return `${provider} ${model}`;
}

function formatModelDisplay(modelId: string): string {
	const slashIndex = modelId.lastIndexOf("/");
	return slashIndex >= 0 ? modelId.slice(slashIndex + 1) : modelId;
}

function formatCwdLabel(cwd: string, cwdIcon: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	const last = parts[parts.length - 1] ?? cwd;
	return cwdIcon ? `${cwdIcon} ${last}` : last;
}

export default function (pi: ExtensionAPI) {
	const state: FooterState = {
		busy: false,
		modelLabel: "no-model",
		providerLabel: "Unknown",
		contextLabel: "--",
		tokenLabel: "↑0 ↓0",
		costLabel: "$0.000",
		runtime: undefined,
		idleSince: Date.now(),
		metaLabel: "Unknown no-model",
		thinkingLabel: "",
		...emptyGitStatus(),
	};

	let currentConfig: PolishedTuiConfig = loadConfig();
	let requestFooterRender: (() => void) | undefined;
	let projectRefreshInFlight = false;
	let projectRefreshPending = false;
	let updateMetaWidget: (() => void) | undefined;

	const refresh = () => requestFooterRender?.();

	const syncState = (ctx: ExtensionContext) => {
		const totals = getUsageTotals(ctx);
		state.modelLabel = ctx.model?.id ?? "no-model";
		state.providerLabel = formatProviderLabel(ctx.model?.provider);
		state.contextLabel = buildContextLabel(ctx);
		state.tokenLabel = buildTokenLabel(totals);
		state.costLabel = buildCostLabel(totals);
		state.metaLabel = buildMetaLabel(state.providerLabel, state.modelLabel);
		const tl = pi.getThinkingLevel();
		state.thinkingLabel = tl && tl !== "off" ? tl : "";
	};

	const refreshProjectState = async (ctx: ExtensionContext) => {
		const [gitStatus, runtime] = await Promise.all([
			readGitStatus(ctx.cwd),
			readRuntimeInfo(ctx.cwd),
		]);
		Object.assign(state, gitStatus);
		state.runtime = runtime;
	};

	const scheduleProjectRefresh = (ctx: ExtensionContext) => {
		if (projectRefreshInFlight) {
			projectRefreshPending = true;
			return;
		}

		projectRefreshInFlight = true;
		void refreshProjectState(ctx).finally(() => {
			projectRefreshInFlight = false;
			refresh();
			if (projectRefreshPending) {
				projectRefreshPending = false;
				scheduleProjectRefresh(ctx);
			}
		});
	};

	const installMetaWidget = (ctx: ExtensionContext) => {
		const metaFactory = () => {
			return {
				render(width: number): string[] {
					const provider = colorize(ctx.ui.theme, "dim", state.providerLabel);
					const model = colorize(ctx.ui.theme, "mdCode", formatModelDisplay(state.modelLabel));
					const thinking = state.thinkingLabel;
					const thinkingSuffix = thinking ? colorize(ctx.ui.theme, "mdCode", ` (${thinking})`) : "";
					const content = `${provider} ${model}${thinkingSuffix}`;
					const contentWidth = visibleWidth(content);
					const pad = Math.max(0, width - contentWidth);
					return [`${" ".repeat(pad)}${content}`];
				},
				invalidate() {},
			};
		};

		ctx.ui.setWidget("zentui-meta", metaFactory, { placement: "aboveEditor" });

		const updateWidget = () => {
			ctx.ui.setWidget("zentui-meta", metaFactory, { placement: "aboveEditor" });
		};
		return updateWidget;
	};

	const installFooter = (ctx: ExtensionContext) => {
		syncState(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => {
				scheduleProjectRefresh(ctx);
				tui.requestRender();
			});
			const tickInterval = setInterval(() => requestFooterRender?.(), 1000);
			const separator = colorize(theme, currentConfig.colors.separator, " | ");

			return {
				dispose: () => {
					clearInterval(tickInterval);
					unsubscribeBranch();
					requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const innerWidth = Math.max(1, width - 2);
					const cwdLabel = colorize(
						theme,
						currentConfig.colors.cwdText,
						formatCwdLabel(ctx.cwd, currentConfig.icons.cwd),
					);
					const branch = state.branch;
					const contextUsage = ctx.getContextUsage();
					const contextColor =
						contextUsage?.percent !== null && contextUsage?.percent !== undefined
							? contextUsage.percent >= 90
								? currentConfig.colors.contextError
								: contextUsage.percent >= 70
									? currentConfig.colors.contextWarning
									: currentConfig.colors.contextNormal
							: currentConfig.colors.contextNormal;
					const gitColor = (text: string) => colorize(theme, currentConfig.colors.git, text);
					const gitStatusColor = (text: string) =>
						colorize(theme, currentConfig.colors.gitStatus, text);
					const gitIcon = gitColor(currentConfig.icons.git);
					const allStatus = [
						state.conflicted > 0 ? currentConfig.icons.conflicted : "",
						state.stashed ? currentConfig.icons.stashed : "",
						state.deleted > 0 ? currentConfig.icons.deleted : "",
						state.renamed > 0 ? currentConfig.icons.renamed : "",
						state.modified > 0 ? currentConfig.icons.modified : "",
						state.typechanged > 0 ? currentConfig.icons.typechanged : "",
						state.staged > 0 ? currentConfig.icons.staged : "",
						state.untracked > 0 ? currentConfig.icons.untracked : "",
					].join("");
					const aheadBehind =
						state.ahead > 0 && state.behind > 0
							? currentConfig.icons.diverged
							: state.ahead > 0
								? currentConfig.icons.ahead
								: state.behind > 0
									? currentConfig.icons.behind
									: "";
					const statusBlock =
						allStatus || aheadBehind ? gitStatusColor(`[${allStatus}${aheadBehind}]`) : "";
					const branchLabel = branch
						? `${colorize(theme, "text", "on")} ${gitIcon} ${gitColor(branch)}${statusBlock ? ` ${statusBlock}` : ""}`
						: "";
					const runtimeLabel = formatRuntimeSegment(theme, state.runtime, "text");

					const left = [cwdLabel, branchLabel, runtimeLabel].filter(Boolean).join(" ");
					const codexQuotaLabel = isCodexModel(ctx)
						? formatCodexQuotaLabel(theme, getCodexQuotaDisplay(footerData))
						: undefined;
					const right = [
						colorize(theme, contextColor, state.contextLabel),
						colorize(theme, currentConfig.colors.tokens, state.tokenLabel),
						codexQuotaLabel ?? colorize(theme, currentConfig.colors.cost, state.costLabel),
						colorize(
							theme,
							state.idleSince !== undefined
								? idleMinutes(state.idleSince) >= 59
									? "error"
									: idleMinutes(state.idleSince) >= 55
										? "warning"
										: currentConfig.colors.submitTime
								: currentConfig.colors.submitTime,
							state.idleSince !== undefined ? formatElapsed(state.idleSince) : "--",
						),
					].join(separator);

					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					const content =
						leftWidth >= innerWidth
							? truncateToWidth(left, innerWidth)
							: leftWidth + 1 + rightWidth <= innerWidth
								? `${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`
								: left;
					return [` ${content} `];
				},
			};
		});
	};

	const installEditor = (ctx: ExtensionContext) => {
		syncState(ctx);

		let currentEditor: PolishedEditor | undefined;
		let autocompleteFixed = false;

		type AutocompleteEditorInternals = {
			autocompleteProvider?: unknown;
		};

		const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const editor = new PolishedEditor(
				tui,
				theme,
				keybindings,
				ctx.ui.theme,
				() => "", // meta now in widget above editor
				() => pi.getThinkingLevel(),
				currentConfig.colors.rail,
			);
			currentEditor = editor;

			const originalHandleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const editorInternals = editor as unknown as AutocompleteEditorInternals;
				if (!autocompleteFixed && !editorInternals.autocompleteProvider) {
					autocompleteFixed = true;
					ctx.ui.setEditorComponent(editorFactory);
					currentEditor?.handleInput(data);
					return;
				}
				originalHandleInput(data);
			};

			return editor;
		};

		ctx.ui.setEditorComponent(editorFactory);
	};

	const installUi = (ctx: ExtensionContext) => {
		ensureConfigExists();
		currentConfig = loadConfig();
		patchUserMessageComponent(ctx.ui.theme, currentConfig.colors.rail);
		installFooter(ctx);
		installEditor(ctx);
		updateMetaWidget = installMetaWidget(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	};

	pi.on("session_start", async (_event, ctx) => {
		installUi(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.busy = true;
		state.idleSince = undefined;
		syncState(ctx);
		refresh();
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.busy = false;
		state.idleSince = Date.now();
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		updateMetaWidget?.();
		refresh();
	});

	pi.on("model_select", async (_event, ctx) => {
		syncState(ctx);
		updateMetaWidget?.();
		refresh();
	});

	pi.on("message_end", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		updateMetaWidget?.();
		refresh();
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});

	pi.on("session_compact", async (_event, ctx) => {
		syncState(ctx);
		scheduleProjectRefresh(ctx);
		refresh();
	});
}
