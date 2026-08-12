/**
 * Helpers for describing failures in logs and Telegram notices without leaking
 * message bodies, credentials, session cookies, or full API payloads.
 *
 * Instagram and Telegram errors routinely carry the whole HTTP response body in
 * `error.message`, which for a direct-message send includes the message text.
 * Never log a raw error object or `error.message` from bridge code — go through
 * `describeError` instead.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/sessionid=[^;\s"']+/gi, 'sessionid=[redacted]'],
	[/csrftoken=[^;\s"']+/gi, 'csrftoken=[redacted]'],
	[/ds_user_id=[^;\s"']+/gi, 'ds_user_id=[redacted]'],
	[/\bbot\d{6,}:[\w-]+/g, '[redacted-bot-token]'],
	[
		/(?:password|enc_password|access_token|token|authorization)\s*[:=]\s*\S+/gi,
		'[redacted-credential]',
	],
];

const MAX_ERROR_LENGTH = 160;

/** The error's class name — safe to log, and enough to classify a failure. */
export function errorClass(error: unknown): string {
	if (error instanceof Error) return error.name || error.constructor.name;
	if (error === null || error === undefined) return 'UnknownError';
	return typeof error;
}

/**
 * A short, sanitized description of an error: class name plus an HTTP status
 * when there is one. Free-text detail is included only when it is short and
 * carries no obvious secret, and is always truncated.
 */
export function describeError(error: unknown): string {
	const name = errorClass(error);
	const status = extractStatus(error);
	const detail = sanitize(extractMessage(error));

	const parts = [name];
	if (status !== undefined) parts.push(`http_${status}`);
	if (detail) parts.push(detail);
	return parts.join(' ');
}

function extractStatus(error: unknown): number | undefined {
	const candidate = error as {
		response?: {statusCode?: number; status?: number};
		error_code?: number;
		statusCode?: number;
	} | null;
	if (!candidate || typeof candidate !== 'object') return undefined;

	return (
		candidate.response?.statusCode ??
		candidate.response?.status ??
		candidate.error_code ??
		candidate.statusCode
	);
}

function extractMessage(error: unknown): string {
	if (!(error instanceof Error)) return '';
	const {message} = error;
	if (!message) return '';

	// A response body dumped into the message is not safe to keep: for a direct
	// message send it contains the text that was sent.
	if (message.includes('{') || message.includes('<')) return '';
	return message;
}

function sanitize(text: string): string {
	if (!text) return '';

	let result = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}

	result = result.replace(/\s+/g, ' ').trim();
	return result.length > MAX_ERROR_LENGTH ? `${result.slice(0, MAX_ERROR_LENGTH)}…` : result;
}

/**
 * Builds a `key=value` log line from safe fields only. Callers are responsible
 * for passing hashed identifiers (see `logTag`) rather than raw Instagram IDs.
 */
export function logFields(fields: Record<string, string | number | boolean | undefined>): string {
	return Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== '')
		.map(([key, value]) => `${key}=${value}`)
		.join(' ');
}
