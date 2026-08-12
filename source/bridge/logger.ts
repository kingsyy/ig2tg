import {createContextualLogger as baseLogger} from '../utils/logger.js';

const LOG_LEVELS = {debug: 0, info: 1, warn: 2, error: 3} as const;
let minLevel: number = LOG_LEVELS.info;

export function setLogLevel(level: keyof typeof LOG_LEVELS): void {
	minLevel = LOG_LEVELS[level];
}

export function createLogger(context: string) {
	const tag = `bridge:${context}`;
	const file = baseLogger(tag);

	function stamp(level: string, message: string): string {
		return `${new Date().toISOString()} [${tag}] ${level}: ${message}`;
	}

	return {
		/**
		 * Raw error objects are deliberately not forwarded. An Instagram or grammY
		 * error carries the HTTP request/response body, which for a direct message
		 * includes its text. Callers pass a sanitized string (see `describeError`).
		 */
		error(message: string) {
			console.error(stamp('ERROR', message));
			file.error(message);
		},
		warn(message: string) {
			if (minLevel <= LOG_LEVELS.warn) {
				console.warn(stamp('WARN', message));
			}
			file.warn(message);
		},
		info(message: string) {
			if (minLevel <= LOG_LEVELS.info) {
				console.log(stamp('INFO', message));
			}
			file.info(message);
		},
		/**
		 * Debug output is dropped entirely below the configured level rather than
		 * only being hidden from the console — otherwise it still reaches the log
		 * file on the persistent volume.
		 */
		debug(message: string) {
			if (minLevel > LOG_LEVELS.debug) return;
			console.log(stamp('DEBUG', message));
			file.debug(message);
		},
	};
}
