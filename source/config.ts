import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import {createContextualLogger} from './utils/logger.js';

type LoginConfig = {
	defaultUsername?: string;
	currentUsername?: string;
};

type AdvancedConfig = {
	debugMode: boolean;
	dataDir: string;
	usersDir: string;
	cacheDir: string;
	mediaDir: string;
	logsDir: string;
};

type Config = {
	login: LoginConfig;
	advanced: AdvancedConfig;
};

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.ig2tg');

const DEFAULT_CONFIG: Config = {
	login: {
		defaultUsername: undefined,
		currentUsername: undefined,
	},
	advanced: {
		debugMode: false,
		dataDir: DEFAULT_DATA_DIR,
		usersDir: path.join(DEFAULT_DATA_DIR, 'users'),
		cacheDir: path.join(DEFAULT_DATA_DIR, 'cache'),
		mediaDir: path.join(DEFAULT_DATA_DIR, 'media'),
		logsDir: path.join(DEFAULT_DATA_DIR, 'logs'),
	},
};

export class ConfigManager {
	public static getInstance(): ConfigManager {
		ConfigManager.instance ||= new ConfigManager();
		return ConfigManager.instance;
	}

	private static instance: ConfigManager;
	private config: Config;
	private readonly configDir: string;
	private readonly configFile: string;
	private readonly logger = createContextualLogger('ConfigManager');

	private constructor() {
		this.configDir = DEFAULT_CONFIG.advanced.dataDir;
		this.configFile = path.join(this.configDir, 'config.yaml');
		this.config = {...DEFAULT_CONFIG};
	}

	public async initialize(): Promise<void> {
		await this.loadConfig();
	}

	public get<T = string>(keyPath: string, defaultValue?: T): T {
		const keys = keyPath.split('.');
		let value: any = this.config;

		for (const key of keys) {
			if (value && typeof value === 'object' && key in value) {
				value = value[key];
			} else {
				return defaultValue as T;
			}
		}

		return value as T;
	}

	public async set(keyPath: string, value: any): Promise<void> {
		const keys = keyPath.split('.');
		let current: any = this.config;

		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (key && !(key in current)) {
				current[key] = {};
			}

			if (key) {
				current = current[key];
			}
		}

		const lastKey = keys.at(-1);
		if (lastKey) {
			current[lastKey] = value;
		}

		await this.saveConfig();
	}

	public getConfig(): Config {
		return {...this.config};
	}

	private async loadConfig(): Promise<void> {
		try {
			await fs.mkdir(this.configDir, {recursive: true});

			const configExists = await fs
				.access(this.configFile)
				.then(() => true)
				.catch(() => false);

			if (configExists) {
				const configData = await fs.readFile(this.configFile, 'utf8');
				const loadedConfig = yaml.load(configData) as Partial<Config>;
				this.config = this.mergeConfig(DEFAULT_CONFIG, loadedConfig);
			} else {
				await this.saveConfig();
			}
		} catch (error) {
			this.logger.error('Error loading config:', error);
			this.config = {...DEFAULT_CONFIG};
		}
	}

	private mergeConfig(
		defaultConfig: Config,
		loadedConfig: Partial<Config>,
	): Config {
		return {
			...defaultConfig,
			...loadedConfig,
			login: {...defaultConfig.login, ...loadedConfig.login},
			advanced: {...defaultConfig.advanced, ...loadedConfig.advanced},
		};
	}

	private async saveConfig(): Promise<void> {
		try {
			await fs.mkdir(this.configDir, {recursive: true});
			const yamlContent = yaml.dump(this.config);
			await fs.writeFile(this.configFile, yamlContent, 'utf8');
		} catch (error) {
			this.logger.error('Error saving config:', error);
		}
	}
}
