import {Bot, type Context} from 'grammy';
import type Database from 'better-sqlite3';
import {InstagramClient} from '../client.js';
import type {BridgeConfig} from './config.js';
import {
	getAllActiveThreads,
	getAllThreads,
	getMessageCount,
	setThreadActive,
	clearAllData,
	countOutboundByStatus,
	getFailedOutbound,
	getOutboundByTgMessageId,
} from './db.js';
import {routeTelegramToIG} from './sync.js';
import {igState, hookIGEvents, backfillRecentThreads, detachIGEvents} from './index.js';
import {reconcileRecentMessages} from './reconcile.js';
import {retryRecord, type ProcessDeps} from './outbound.js';
import {bridgeHealth, formatWhen} from './health.js';
import {createLogger} from './logger.js';
import {describeError} from '../utils/redact.js';

const logger = createLogger('telegram');

/** Pending 2FA state — lives only in memory. */
let pending2FA: {
	ig: InstagramClient;
	twoFactorIdentifier: string;
	totp: boolean;
} | null = null;

export function createBot(
	config: BridgeConfig,
	db: Database.Database,
): Bot<Context> {
	const bot = new Bot(config.telegram.bot_token);

	bot.catch((err) => {
		logger.error(`grammY error: ${describeError(err.error)}`);
	});

	registerCommands(bot, db, config);
	registerMessageHandler(bot, db, config);

	logger.info('Telegram bot initialized');
	logger.info(`Listening in supergroup ${config.telegram.supergroup_id} for owner ${config.telegram.owner_id}`);
	return bot;
}

/**
 * Checks that the message comes from the owner AND from the configured supergroup.
 * This prevents the bot from responding in any other chat, even if someone adds it
 * to their own group.
 */
function isAuthorized(ctx: Context, config: BridgeConfig): boolean {
	const fromOk = ctx.from?.id === config.telegram.owner_id;
	const chatOk = ctx.chat?.id === config.telegram.supergroup_id;

	if (!fromOk || !chatOk) {
		logger.debug(
			`Auth rejected: from=${ctx.from?.id} (expected ${config.telegram.owner_id}, ${fromOk ? 'OK' : 'MISMATCH'}), ` +
			`chat=${ctx.chat?.id} (expected ${config.telegram.supergroup_id}, ${chatOk ? 'OK' : 'MISMATCH'})`,
		);
	}

	return fromOk && chatOk;
}

function requireIG(ctx: Context): boolean {
	if (!igState.client) {
		ctx.reply('⚠️ Instagram is not connected. Use /login username password').catch(() => {});
		return false;
	}
	return true;
}

function registerCommands(
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): void {
	// ─── Help ───────────────────────────────────────────

	bot.command('help', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		await ctx.reply(
			`*ig2tg — Available Commands*\n\n` +
			`*Authentication*\n` +
			`/login user pass — Connect Instagram (auto-deleted)\n` +
			`/2fa code — Complete two-factor auth\n` +
			`/logout — Disconnect Instagram\n\n` +
			`*Bridge*\n` +
			`/status — Connection state & stats\n` +
			`/reconnect — Reconnect Instagram realtime now\n` +
			`/sync — Check for missed Instagram messages\n` +
			`/retry — Reply to a failed message to resend it\n` +
			`/cleanup — Delete all topics and reset DB\n\n` +
			`*Contacts*\n` +
			`/contacts — List bridged contacts\n` +
			`/mute @user — Stop forwarding from a contact\n` +
			`/unmute @user — Resume forwarding\n\n` +
			`Reply in any topic to send a message back to Instagram.`,
			{parse_mode: 'Markdown'},
		);
	});

	bot.command('start', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;
		await ctx.reply('Use /help to see available commands.');
	});

	// ─── Authentication ─────────────────────────────────

	bot.command('login', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		// Delete the message immediately — it contains credentials
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id);
		} catch {}

		const args = ctx.match?.trim().split(/\s+/);
		if (!args || args.length < 2) {
			await ctx.reply('Usage: /login username password\n\n⚠️ The message will be auto-deleted for security.');
			return;
		}

		const [username, ...passwordParts] = args;
		const password = passwordParts.join(' ');

		await ctx.reply(`🔄 Logging in as @${username}...`);

		try {
			const ig = new InstagramClient(username);
			const result = await ig.login(username!, password);

			if (result.success) {
				igState.client = ig;
				pending2FA = null;
				hookIGEvents(ig, bot, db, config);

				await ctx.reply(`✅ Logged in as @${result.username}`);
				logger.info(`Logged in as @${result.username} via /login`);

				if (config.bridge.backfill_on_start) {
					await ctx.reply('🔄 Backfilling recent threads...');
					try {
						await backfillRecentThreads(ig, db, bot, config);
						await ctx.reply('✅ Backfill complete.');
					} catch (error) {
						await ctx.reply(`⚠️ Backfill failed: ${(error as Error).message}`);
					}
				}
			} else if (result.twoFactorInfo) {
				pending2FA = {
					ig,
					twoFactorIdentifier: result.twoFactorInfo.two_factor_identifier,
					totp: result.twoFactorInfo.totp_two_factor_on,
				};
				const method = result.twoFactorInfo.totp_two_factor_on ? 'authenticator app' : 'SMS';
				await ctx.reply(`🔐 2FA required (${method}). Send: /2fa <code>`);
			} else if (result.badPassword) {
				await ctx.reply('❌ Bad password.');
			} else if (result.checkpointError) {
				await ctx.reply('❌ Instagram checkpoint challenge required. Try logging in from the IG app first to clear it, then retry /login.');
			} else {
				await ctx.reply(`❌ Login failed: ${result.error || 'unknown error'}`);
			}
		} catch (error) {
			await ctx.reply(`❌ Login error: ${(error as Error).message}`);
		}
	});

	bot.command('2fa', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		// Delete the message — contains the code
		try {
			await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id);
		} catch {}

		if (!pending2FA) {
			await ctx.reply('No pending 2FA. Use /login first.');
			return;
		}

		const code = ctx.match?.trim();
		if (!code) {
			await ctx.reply('Usage: /2fa <code>');
			return;
		}

		await ctx.reply('🔄 Verifying 2FA code...');

		try {
			const result = await pending2FA.ig.twoFactorLogin({
				verificationCode: code,
				twoFactorIdentifier: pending2FA.twoFactorIdentifier,
				totp_two_factor_on: pending2FA.totp,
			});

			if (result.success) {
				igState.client = pending2FA.ig;
				hookIGEvents(pending2FA.ig, bot, db, config);
				pending2FA = null;

				await ctx.reply(`✅ Logged in as @${result.username}`);
				logger.info(`Logged in as @${result.username} via /2fa`);

				if (config.bridge.backfill_on_start) {
					await ctx.reply('🔄 Backfilling recent threads...');
					try {
						await backfillRecentThreads(igState.client, db, bot, config);
						await ctx.reply('✅ Backfill complete.');
					} catch (error) {
						await ctx.reply(`⚠️ Backfill failed: ${(error as Error).message}`);
					}
				}
			} else {
				await ctx.reply(`❌ 2FA failed: ${result.error || 'invalid code'}`);
			}
		} catch (error) {
			await ctx.reply(`❌ 2FA error: ${(error as Error).message}`);
		}
	});

	bot.command('logout', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		if (!igState.client) {
			await ctx.reply('Not logged in.');
			return;
		}

		try {
			await igState.client.shutdown();
		} catch {}

		igState.client = null;
		pending2FA = null;
		detachIGEvents();

		const queued = countOutboundByStatus(db);
		const waiting = queued.pending + queued.sending;
		await ctx.reply(
			'✅ Disconnected from Instagram. Use /login to reconnect.' +
			(waiting > 0 ? `\n\n${waiting} outgoing message(s) stay queued until you log in again.` : ''),
		);
		logger.info('Logged out via /logout');
	});

	// ─── Bridge commands ────────────────────────────────

	bot.command('status', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		const ig = igState.client;
		const threads = getAllActiveThreads(db);
		const msgCount = getMessageCount(db);
		const queue = countOutboundByStatus(db);
		const reconciliation = bridgeHealth.lastReconciliation;

		// Container health and Instagram realtime health are reported separately:
		// the container can run continuously through an MQTT outage.
		const realtime = ig ? ig.getRealtimeStatus() : 'not connected';
		const realtimeDetail =
			realtime === 'reconnecting' && ig
				? ` (attempt ${ig.getReconnectAttempt() + 1})`
				: '';

		const lines = [
			`🔗 *Bridge Status*`,
			``,
			`Application: \`running\``,
			`Instagram session: \`${ig ? 'authenticated' : 'not connected'}\``,
			`Instagram realtime: \`${realtime}${realtimeDetail}\``,
			`Last realtime event: ${formatWhen(ig?.getLastRealtimeEventAt())}`,
			`Last message check: ${
				reconciliation
					? `${formatWhen(reconciliation.at)} (${reconciliation.forwarded} forwarded, ${reconciliation.failures} failed)`
					: 'never'
			}`,
			`Pending outgoing: ${queue.pending + queue.sending}`,
			`Failed outgoing: ${queue.failed}`,
			``,
			`Active threads: ${threads.length}`,
			`Messages forwarded: ${msgCount}`,
			`IG user: @${ig?.getUsername() || 'none'}`,
		];

		if (queue.failed > 0) {
			lines.push('', `Reply to a failed message with /retry to resend it.`);
		}

		await ctx.reply(lines.join('\n'), {parse_mode: 'Markdown'});
	});

	bot.command('reconnect', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;
		if (!requireIG(ctx)) return;

		await ctx.reply('🔄 Reconnecting Instagram realtime...');
		try {
			const outcome = await igState.client!.reconnectRealtime();
			const replies = {
				connected: '✅ Instagram realtime reconnected.',
				in_progress: '🔄 A reconnect is already in progress. Check /status in a moment.',
				failed: '⚠️ Reconnect failed. The bridge will keep retrying in the background.',
			} as const;
			await ctx.reply(replies[outcome]);
		} catch (error) {
			logger.error(`Reconnect command failed: ${describeError(error)}`);
			await ctx.reply('❌ Reconnect failed. The bridge will keep retrying in the background.');
		}
	});

	bot.command('retry', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;
		if (!requireIG(ctx)) return;

		const replyTo = ctx.message?.reply_to_message;
		const chatId = ctx.chat!.id;

		const record = replyTo
			? getOutboundByTgMessageId(db, chatId, replyTo.message_id)
			: getFailedOutbound(db, 1)[0];

		if (!record) {
			await ctx.reply(
				replyTo
					? '⚠️ That message is not a queued Instagram send.'
					: '⚠️ Nothing to retry. Reply to a failed message with /retry.',
				{message_thread_id: ctx.message?.message_thread_id},
			);
			return;
		}

		const deps: ProcessDeps = {
			db,
			ig: igState.client!,
			api: ctx.api,
			bot,
			config,
		};

		const outcome = await retryRecord(deps, record.id);

		// A successful retry announces itself in the topic; only report the
		// outcomes that would otherwise be silent.
		if (outcome === 'not_eligible') {
			await ctx.reply(`⚠️ That message is already \`${record.status}\`.`, {
				message_thread_id: ctx.message?.message_thread_id,
				parse_mode: 'Markdown',
			});
		} else if (outcome === 'retrying') {
			await ctx.reply('🔄 Instagram is not accepting it yet. Kept queued for another attempt.', {
				message_thread_id: ctx.message?.message_thread_id,
			});
		}
	});

	bot.command('mute', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		const username = ctx.match?.replace('@', '').trim();
		if (!username) {
			await ctx.reply('Usage: /mute @username');
			return;
		}

		const threads = getAllActiveThreads(db);
		const thread = threads.find(t => t.ig_username.toLowerCase() === username.toLowerCase());
		if (!thread) {
			await ctx.reply(`No active thread found for @${username}`);
			return;
		}

		setThreadActive(db, thread.ig_thread_id, false);

		try {
			await ctx.api.closeForumTopic(config.telegram.supergroup_id, thread.tg_topic_id);
		} catch {}

		await ctx.reply(`🔇 Muted @${username}`);
	});

	bot.command('unmute', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		const username = ctx.match?.replace('@', '').trim();
		if (!username) {
			await ctx.reply('Usage: /unmute @username');
			return;
		}

		const row = db.prepare('SELECT * FROM thread_map WHERE ig_username = ? COLLATE NOCASE').get(username) as any;
		if (!row) {
			await ctx.reply(`No thread found for @${username}`);
			return;
		}

		setThreadActive(db, row.ig_thread_id, true);

		try {
			await ctx.api.reopenForumTopic(config.telegram.supergroup_id, row.tg_topic_id);
		} catch {}

		await ctx.reply(`🔊 Unmuted @${username}`);
	});

	bot.command('contacts', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		const threads = getAllActiveThreads(db);
		if (threads.length === 0) {
			await ctx.reply('No bridged contacts yet.');
			return;
		}

		const lines = threads.map((t, i) =>
			`${i + 1}. @${t.ig_username}${t.ig_full_name ? ` (${t.ig_full_name})` : ''}`,
		);

		await ctx.reply(`📋 *Bridged Contacts*\n\n${lines.join('\n')}`, {
			parse_mode: 'Markdown',
		});
	});

	/**
	 * A bounded reconciliation: verify the session, make sure recent threads have
	 * topics, then forward anything recent that never reached Telegram.
	 * Reports aggregate counts only — never message contents.
	 */
	bot.command('sync', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;
		if (!requireIG(ctx)) return;

		const ig = igState.client!;
		await ctx.reply('🔄 Checking Instagram for missed messages...');

		try {
			if (!(await ig.checkSession())) {
				await ctx.reply('❌ Instagram session is not authenticated. Use /login to reconnect.');
				return;
			}

			await backfillRecentThreads(ig, db, bot, config);
			const result = await reconcileRecentMessages(ig, bot, db, config);

			await ctx.reply(
				`✅ Sync complete\n` +
				`Threads checked: ${result.threadsChecked}\n` +
				`Missing messages forwarded: ${result.forwarded}\n` +
				`Failures: ${result.failures}`,
			);
		} catch (error) {
			logger.error(`Sync failed: ${describeError(error)}`);
			await ctx.reply('❌ Sync failed. Check the bridge log for the error class.');
		}
	});

	let cleanupPending = false;

	bot.command('cleanup', async (ctx) => {
		if (!isAuthorized(ctx, config)) return;

		if (!cleanupPending) {
			const threads = getAllThreads(db);
			const msgCount = getMessageCount(db);
			cleanupPending = true;
			await ctx.reply(
				`⚠️ This will delete all ${threads.length} topic(s) and ${msgCount} message log(s) from the supergroup and database.\n\n` +
				`Send /cleanup again within 30 seconds to confirm.`,
			);
			setTimeout(() => { cleanupPending = false; }, 30_000);
			return;
		}

		cleanupPending = false;
		await ctx.reply('🗑 Cleaning up...');

		const threads = getAllThreads(db);
		let deleted = 0;
		let failed = 0;

		for (const thread of threads) {
			try {
				await bot.api.deleteForumTopic(config.telegram.supergroup_id, thread.tg_topic_id);
				deleted++;
				// Pace to avoid rate limits
				await new Promise(r => setTimeout(r, 500));
			} catch {
				// Topic may already be deleted or inaccessible
				failed++;
			}
		}

		const cleared = clearAllData(db);

		await ctx.reply(
			`✅ Cleanup complete.\n\n` +
			`Topics deleted: ${deleted}${failed > 0 ? ` (${failed} failed)` : ''}\n` +
			`DB cleared: ${cleared.threads} threads, ${cleared.messages} messages`,
		);
		logger.info(`Cleanup: deleted ${deleted} topics, cleared ${cleared.threads} threads and ${cleared.messages} messages`);
	});
}

function registerMessageHandler(
	bot: Bot<Context>,
	db: Database.Database,
	config: BridgeConfig,
): void {
	bot.on('message', async (ctx) => {
		// Metadata only. Message text — even a short preview — is never logged.
		logger.debug(
			`Update from chat=${ctx.chat?.id} user=${ctx.from?.id} ` +
			`thread=${ctx.message.message_thread_id ?? 'none'} ` +
			`content_type=${describeContentType(ctx)}`,
		);

		if (ctx.message.text?.startsWith('/')) return;
		if (ctx.chat?.id !== config.telegram.supergroup_id) {
			logger.debug('Ignored: wrong chat');
			return;
		}
		if (!ctx.message.message_thread_id) {
			logger.debug('Ignored: not in a topic thread');
			return;
		}
		if (!igState.client) {
			logger.debug('Ignored: Instagram not connected');
			return;
		}

		await routeTelegramToIG(ctx, igState.client, bot, db, config);
	});
}

/** Names the payload kind for logs without touching its contents. */
function describeContentType(ctx: Context): string {
	const message = ctx.message;
	if (!message) return 'none';
	if (message.text) return 'text';
	if (message.photo) return 'photo';
	if (message.video) return 'video';
	if (message.voice) return 'voice';
	return 'other';
}

