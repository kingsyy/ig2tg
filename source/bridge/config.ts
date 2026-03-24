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
	}),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function loadBridgeConfig(configPath: string): BridgeConfig {
	const raw = fs.readFileSync(configPath, 'utf8');
	const parsed = yaml.load(raw);
	const resolved = resolveDeep(parsed);
	return BridgeConfigSchema.parse(resolved);
}
