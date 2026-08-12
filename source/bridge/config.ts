import fs from 'node:fs';
import yaml from 'js-yaml';
import {z} from 'zod';

/**
 * Resolve ${env:VAR} and ${env:VAR:-default} references in a string.
 * When the entire value is a single reference, the result is coerced
 * to number/boolean so Zod gets the right type.
 */
function resolveEnvVars(value: string): string | number | boolean {
	// Entire value is a single env-var reference → coerce types
	const fullMatch = /^\$\{env:(\w+)(?::-(.+))?\}$/.exec(value);
	if (fullMatch) {
		const envVal = process.env[fullMatch[1]!];
		const resolved = envVal ?? fullMatch[2];
		if (resolved === undefined) {
			throw new Error(
				`Environment variable ${fullMatch[1]} is not set and no default provided`,
			);
		}
		if (/^-?\d+(\.\d+)?$/.test(resolved)) return Number(resolved);
		if (resolved === 'true') return true;
		if (resolved === 'false') return false;
		return resolved;
	}

	// Partial / multiple references inside a larger string → stay string
	return value.replace(
		/\$\{env:(\w+)(?::-([^}]*))?\}/g,
		(_, name: string, fallback?: string) => {
			const envVal = process.env[name];
			if (envVal !== undefined) return envVal;
			if (fallback !== undefined) return fallback;
			throw new Error(
				`Environment variable ${name} is not set and no default provided`,
			);
		},
	);
}

/** Walk an object tree and resolve env-var references in every string leaf. */
function resolveDeep(obj: unknown): unknown {
	if (typeof obj === 'string') return resolveEnvVars(obj);
	if (Array.isArray(obj)) return obj.map(resolveDeep);
	if (obj !== null && typeof obj === 'object') {
		return Object.fromEntries(
			Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
				k,
				resolveDeep(v),
			]),
		);
	}
	return obj;
}

const BridgeConfigSchema = z.object({
	telegram: z.object({
		bot_token: z.string(),
		supergroup_id: z.number(),
		owner_id: z.number(),
	}),
	bridge: z.object({
		db_path: z.string().default('./data/bridge.sqlite'),
		media_timeout_ms: z.number().default(15000),
		backfill_on_start: z.boolean().default(true),
		backfill_count: z.number().default(20),
		topic_name_format: z.string().default('@{username}'),
		log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

		/** Threads inspected by a reconciliation pass, most recently active first. */
		reconcile_thread_count: z.number().default(10),
		/** Recent messages inspected per thread during reconciliation. */
		reconcile_message_count: z.number().default(30),
		/**
		 * Forward messages you sent from the Instagram app into Telegram, prefixed
		 * with "📤 You". Echoes of the bridge's own sends are filtered out by
		 * client_context, so this does not duplicate what you sent from Telegram.
		 */
		forward_own_messages: z.boolean().default(true),
		/**
		 * How long realtime must stay down before Telegram is warned. Absorbs the
		 * brief MQTT blips that reconnect on their own.
		 */
		disconnect_warn_after_seconds: z.number().default(45),
		/** Bounded automatic attempts per outgoing message before it is left failed. */
		outbound_max_attempts: z.number().default(4),
		/** How long delivered outbound records are kept before pruning. */
		outbound_retention_days: z.number().default(7),
	}),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function loadBridgeConfig(configPath: string): BridgeConfig {
	const raw = fs.readFileSync(configPath, 'utf8');
	const parsed = yaml.load(raw);
	const resolved = resolveDeep(parsed);
	return BridgeConfigSchema.parse(resolved);
}
