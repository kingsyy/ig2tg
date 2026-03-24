import type {Api, Bot, Context} from 'grammy';
import {InputFile} from 'grammy';
import type {InstagramClient} from '../client.js';
import type {Message as IGMessage} from '../types/instagram.js';
import {getBestMediaUrl} from '../utils/message-parser.js';
import {createLogger} from './logger.js';

const logger = createLogger('media');

/**
 * Downloads IG media and sends it to a Telegram topic.
 * Returns the Telegram message ID.
 */
export async function forwardMediaToTelegram(
	bot: Bot<Context>,
	ig: InstagramClient,
	chatId: number,
	topicId: number,
	message: IGMessage,
	caption?: string,
	replyToMessageId?: number,
): Promise<number> {
	if (message.itemType !== 'media' || !message.media) {
		throw new Error('Message does not contain media');
	}

	const replyParams = replyToMessageId
		? {reply_parameters: {message_id: replyToMessageId, allow_sending_without_reply: true as const}}
		: {};

	const result = getBestMediaUrl(message.media);
	if (!result) {
		// Fallback: send as text placeholder
		const sent = await bot.api.sendMessage(
			chatId,
			caption ? `${caption}\n[Media unavailable]` : '[Media unavailable]',
			{message_thread_id: topicId, ...replyParams},
		);
		return sent.message_id;
	}

	logger.debug(`Downloading ${result.type} from IG CDN`);

	const buffer = await ig.downloadMedia(result.url);
	const inputFile = new InputFile(buffer, `media.${result.type === 'image' ? 'jpg' : 'mp4'}`);

	if (result.type === 'video') {
		const sent = await bot.api.sendVideo(chatId, inputFile, {
			message_thread_id: topicId,
			caption,
			...replyParams,
		});
		return sent.message_id;
	}

	const sent = await bot.api.sendPhoto(chatId, inputFile, {
		message_thread_id: topicId,
		caption,
		...replyParams,
	});
	return sent.message_id;
}

/**
 * Downloads a file from Telegram and returns it as a Buffer.
 */
export async function downloadTelegramFile(
	api: Api,
	fileId: string,
): Promise<Buffer> {
	const file = await api.getFile(fileId);
	const url = `https://api.telegram.org/file/bot${api.token}/${file.file_path}`;

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download TG file: ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
}
