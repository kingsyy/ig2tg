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
		error(message: string, error?: Error | unknown) {
			console.error(stamp('ERROR', message), error ?? '');
			file.error(message, error);
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
		debug(message: string) {
			if (minLevel <= LOG_LEVELS.debug) {
				console.log(stamp('DEBUG', message));
			}
			file.debug(message);
		},
	};
}
