import { Context as TgContext, Markup } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { LocaleMessages } from '../i18n/type';
import { CONVERSATION_TTL, ConversationRow, ConversationStore, conversationNow } from './conversation-store';

const CALLBACK_PREFIX = 'cv1:';
const PAGE_SIZE = 8;
const CALLBACK = /^cv1:([a-f0-9]{32}):([0-9a-z]{1,8}):(pick|prev|next|text|yes|cancel)(?::(\d{1,2}))?$/;

export type Params = Record<string, string>;
type Option = { label: string; value: string };
type TextInput = { text: string; field: string; placeholder?: string };
export type Prompt =
    | ({ kind: 'input' } & TextInput)
    | { kind: 'selection'; text: string; field: string; options: Option[]; manual?: TextInput }
    | { kind: 'confirmation'; text: string };

export interface CommandReply {
    text: string;
    reply_markup?: InlineKeyboardMarkup;
    parse_mode?: 'Markdown';
    retry?: Prompt;
    retryParams?: Params;
}

export interface CommandContext {
    userId: string;
    msgs: LocaleMessages;
}

export interface ConversationCommand {
    parse?: (payload: string) => Params;
    allowed?: (context: CommandContext) => string | undefined;
    prompt?: (params: Params, context: CommandContext) => Promise<Prompt | undefined>;
    execute: (params: Params, context: CommandContext) => Promise<CommandReply>;
}

interface ConversationData {
    params: Params;
    prompt: Prompt;
    page: number;
}

type Runtime = {
    ctx: TgContext;
    msgs: LocaleMessages;
    userId: string;
    updateId: number;
    store: ConversationStore;
};

export const isConversationCallback = (data: string) => data.startsWith(CALLBACK_PREFIX);

export class TelegramConversationManager {
    constructor(
        private readonly db: D1Database,
        private readonly commands: Record<string, ConversationCommand>,
        private readonly messages: (ctx: TgContext) => Promise<LocaleMessages>,
        private readonly authorize: (userId: string) => Promise<boolean>,
        private readonly isInputPrompt: (text: string) => boolean,
    ) {}

    private async runtime(ctx: TgContext): Promise<Runtime> {
        const userId = String(ctx.from!.id);
        const key = { botId: String(ctx.botInfo.id), chatId: String(ctx.chat!.id), userId };
        return { ctx, msgs: await this.messages(ctx), userId, updateId: ctx.update.update_id,
            store: new ConversationStore(this.db, key) };
    }

    async start(ctx: TgContext, name: string, payload: string) {
        const io = await this.runtime(ctx);
        if (!await io.store.claimUpdate(io.updateId)) return;
        const command = this.commands[name];
        const previous = await io.store.get();
        if (previous && previous.last_update_id >= io.updateId && previous.expires_at > conversationNow()) return;
        const denied = await this.authorize(io.userId) ? command.allowed?.(io) : io.msgs.TgNoPermissionMsg;
        if (denied) {
            if (previous && previous.status !== 'executing' && await io.store.clear(previous)) {
                await this.removeKeyboard(io, previous);
            }
            await ctx.reply(denied);
            return;
        }
        const row = await io.store.start(name, io.updateId);
        if (!row) {
            await ctx.reply(io.msgs.TgConversationBusyMsg);
            return;
        }
        try {
            if (previous) await this.removeKeyboard(io, previous);
            await this.progress(io, row, command.parse?.(payload.trim()) ?? {}, false);
        } catch (error) {
            await io.store.clear(row);
            throw error;
        }
    }

    async cancel(ctx: TgContext, silent = false) {
        const io = await this.runtime(ctx);
        if (!await io.store.claimUpdate(io.updateId)) return;
        const row = await io.store.get();
        if (!row || row.last_update_id >= io.updateId) {
            if (!silent) await ctx.reply(io.msgs.TgConversationNoActiveMsg);
            return;
        }
        if (row.status === 'executing' && row.expires_at > conversationNow()) {
            if (!silent) await ctx.reply(io.msgs.TgConversationBusyMsg);
            return;
        }
        const cleared = await io.store.clear(row);
        if (cleared) await this.removeKeyboard(io, row);
        if (!silent) await ctx.reply(!cleared ? io.msgs.TgConversationStaleMsg
            : row.expires_at <= conversationNow() ? io.msgs.TgConversationExpiredMsg
                : io.msgs.TgConversationCancelledMsg);
    }

    async input(ctx: TgContext, text: string, replyId?: number, isPromptReply = false) {
        const io = await this.runtime(ctx);
        const row = await io.store.get();
        if (!row) {
            if (isPromptReply && await io.store.claimUpdate(io.updateId)) await ctx.reply(io.msgs.TgConversationExpiredMsg);
            return;
        }
        if (row.status !== 'awaiting_input' || row.last_update_id >= io.updateId) return;
        if (!row.prompt_id) {
            await ctx.reply(io.msgs.TgConversationBusyMsg);
            return;
        }
        if (replyId !== undefined && replyId !== row.prompt_id) {
            if (isPromptReply) await ctx.reply(io.msgs.TgConversationStaleMsg);
            return;
        }
        if (!await io.store.claimUpdate(io.updateId)) return;
        if (row.expires_at <= conversationNow()) {
            await io.store.clear(row);
            await ctx.reply(io.msgs.TgConversationExpiredMsg);
            return;
        }
        const data = this.readData(row);
        if (data.prompt.kind !== 'input') return;
        const value = text.trim();
        if (!value) {
            await this.render(io, row, { ...data, page: 0 });
            return;
        }
        await this.progress(io, row, { ...data.params, [data.prompt.field]: value }, false);
    }

    async callback(ctx: TgContext, callbackData: string, messageId?: number, messageDate?: number) {
        const io = await this.runtime(ctx);
        let answered = false;
        const answer = (text?: string) => {
            answered = true;
            return ctx.answerCbQuery(text).catch(() => undefined);
        };
        try {
            const match = CALLBACK.exec(callbackData);
            const row = match && messageId ? await io.store.get() : null;
            if (!match || !row || row.session_id !== match[1]) {
                const expired = match && !row && messageDate
                    && messageDate + CONVERSATION_TTL <= conversationNow();
                await answer(expired ? io.msgs.TgConversationExpiredMsg : io.msgs.TgConversationStaleMsg);
                return;
            }
            if (row.expires_at <= conversationNow()) {
                await answer(io.msgs.TgConversationExpiredMsg);
                if (await io.store.clear(row)) await this.removeKeyboard(io, row);
                return;
            }
            if (row.revision !== parseInt(match[2], 36) || messageId !== row.prompt_id
                || row.last_update_id >= io.updateId
                || !['awaiting_selection', 'awaiting_confirmation'].includes(row.status)) {
                await answer(io.msgs.TgConversationStaleMsg);
                return;
            }
            const data = this.readData(row);
            const action = match[3];
            const index = match[4] === undefined ? -1 : Number(match[4]);
            if (!this.allowedAction(data, action, index)) {
                await answer(io.msgs.TgConversationStaleMsg);
                return;
            }
            if (!await io.store.claimUpdate(io.updateId)) {
                await answer(io.msgs.TgConversationStaleMsg);
                return;
            }
            await answer();
            if (action === 'cancel') {
                if (await io.store.clear(row)) await this.reply(io, row, { text: io.msgs.TgConversationCancelledMsg });
                return;
            }
            if (action === 'yes') {
                await this.progress(io, row, data.params, true);
                return;
            }
            if (data.prompt.kind !== 'selection') return;
            if (action === 'text' && data.prompt.manual) {
                await this.render(io, row, { ...data, prompt: { kind: 'input', ...data.prompt.manual } });
                return;
            }
            if (action === 'prev' || action === 'next') {
                const prompt = await this.commands[row.command]?.prompt?.(data.params, io);
                if (prompt?.kind !== 'selection') {
                    await this.progress(io, row, data.params, false);
                    return;
                }
                const page = Math.max(0, Math.min(data.page + (action === 'prev' ? -1 : 1),
                    Math.ceil(prompt.options.length / PAGE_SIZE) - 1));
                await this.render(io, row, { ...data, prompt, page });
                return;
            }
            const option = data.prompt.options[data.page * PAGE_SIZE + index];
            await this.progress(io, row, { ...data.params, [data.prompt.field]: option.value }, false);
        } finally {
            if (!answered) await answer();
        }
    }

    isPrompt(text: string) {
        return this.isInputPrompt(text);
    }

    private readData(row: ConversationRow): ConversationData {
        return JSON.parse(row.data) as ConversationData;
    }

    private allowedAction({ prompt, page }: ConversationData, action: string, index: number) {
        if (action === 'cancel') return true;
        if (prompt.kind === 'confirmation') return action === 'yes';
        if (prompt.kind !== 'selection') return false;
        if (action === 'text') return !!prompt.manual;
        if (action === 'prev') return page > 0;
        if (action === 'next') return (page + 1) * PAGE_SIZE < prompt.options.length;
        return action === 'pick' && index >= 0 && index < PAGE_SIZE && page * PAGE_SIZE + index < prompt.options.length;
    }

    private async progress(io: Runtime, row: ConversationRow, params: Params, confirmed: boolean) {
        const command = this.commands[row.command];
        const denied = command.allowed?.(io);
        if (denied) {
            if (await io.store.clear(row)) await this.reply(io, row, { text: denied });
            return;
        }
        const prompt = confirmed ? undefined : await command.prompt?.(params, io);
        if (prompt) {
            await this.render(io, row, { params, prompt, page: 0 });
            return;
        }
        // This compare-and-set is the only path to a handler. Secrets passed as
        // input are never persisted, and a claimed operation is never retried.
        const executing = await io.store.advance(row, 'executing', '{}', row.prompt_id, io.updateId);
        if (!executing) return;
        let active = executing;
        try {
            if (!await this.authorize(io.userId)) {
                await this.reply(io, row, { text: io.msgs.TgNoPermissionMsg });
                return;
            }
            const result = await command.execute(params, io);
            if (result.retry) {
                active = await this.render(io, executing,
                    { params: result.retryParams ?? {}, prompt: result.retry, page: 0 }) ?? executing;
                return;
            }
            await this.reply(io, row, result);
        } finally {
            // A retry prompt has its own revision and survives cleanup.
            if (active === executing) await io.store.clear(executing);
        }
    }

    private async render(io: Runtime, row: ConversationRow, state: ConversationData) {
        const { prompt, page } = state;
        const status = prompt.kind === 'input' ? 'awaiting_input'
            : prompt.kind === 'selection' ? 'awaiting_selection' : 'awaiting_confirmation';
        const canEdit = row.status === 'awaiting_selection' || row.status === 'awaiting_confirmation';
        const promptId = canEdit && prompt.kind !== 'input' ? row.prompt_id : null;
        const changed = await io.store.advance(row, status, JSON.stringify(state), promptId, io.updateId);
        if (!changed) return;
        try {
            let messageId: number;
            if (prompt.kind === 'input') {
                await this.removeKeyboard(io, row);
                const message = await io.ctx.reply(`${prompt.text}\n\n${io.msgs.TgConversationTextHelpMsg}`, {
                    reply_markup: { force_reply: true, selective: true,
                        input_field_placeholder: prompt.placeholder ?? io.msgs.TgConversationInputPlaceholderMsg },
                });
                messageId = message.message_id;
            } else {
                const data = (action: string, n?: number) =>
                    `${CALLBACK_PREFIX}${changed.session_id}:${changed.revision.toString(36)}:${action}${n === undefined ? '' : `:${n}`}`;
                const rows = prompt.kind === 'confirmation'
                    ? [[Markup.button.callback(io.msgs.TgConversationConfirmDeleteMsg, data('yes'))]]
                    : prompt.options.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                        .map((opt, i) => [Markup.button.callback(opt.label, data('pick', i))]);
                let text = prompt.text;
                if (prompt.kind === 'selection') {
                    const pages = Math.ceil(prompt.options.length / PAGE_SIZE);
                    if (pages > 1) {
                        text += `\n\n${io.msgs.TgConversationPageMsg.replace('{page}', String(page + 1)).replace('{pages}', String(pages))}`;
                        const nav = [];
                        if (page > 0) nav.push(Markup.button.callback(io.msgs.TgConversationPrevPageMsg, data('prev')));
                        if (page + 1 < pages) nav.push(Markup.button.callback(io.msgs.TgConversationNextPageMsg, data('next')));
                        rows.push(nav);
                    }
                    if (prompt.manual) rows.push([Markup.button.callback(io.msgs.TgConversationManualMsg, data('text'))]);
                }
                rows.push([Markup.button.callback(io.msgs.TgConversationCancelMsg, data('cancel'))]);
                messageId = await this.reply(io, row, { text, ...Markup.inlineKeyboard(rows) });
            }
            if (!await io.store.recordPrompt(changed, messageId) && prompt.kind !== 'input') {
                await this.removeKeyboard(io, { ...changed, prompt_id: messageId });
            }
            return changed;
        } catch (error) {
            await io.store.clear(changed);
            throw error;
        }
    }

    private async reply(io: Runtime, row: ConversationRow, result: CommandReply) {
        const { text, reply_markup, parse_mode } = result;
        if (row.prompt_id && ['awaiting_selection', 'awaiting_confirmation'].includes(row.status)) {
            try {
                await io.ctx.telegram.editMessageText(io.ctx.chat!.id, row.prompt_id, undefined, text,
                    { parse_mode, reply_markup: reply_markup ?? { inline_keyboard: [] } });
                return row.prompt_id;
            } catch {
                await this.removeKeyboard(io, row);
            }
        }
        return (await io.ctx.reply(text, { parse_mode, reply_markup })).message_id;
    }

    private async removeKeyboard(io: Runtime, row: ConversationRow) {
        if (!row.prompt_id || !['awaiting_selection', 'awaiting_confirmation'].includes(row.status)) return;
        await io.ctx.telegram.editMessageReplyMarkup(io.ctx.chat!.id, row.prompt_id, undefined, { inline_keyboard: [] })
            .catch(() => undefined);
    }
}
