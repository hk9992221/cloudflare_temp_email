import type { Context } from 'hono';
import { CONSTANTS } from '../constants';
import { getAllowDomains } from '../common';
import { getBooleanValue, normalizeAddressDomain, trimLower, getDomains } from '../utils';
import { getNameRegex } from '../utils/address_creation';
import i18n from '../i18n';
import { bindTelegramAddress, deleteTelegramAddress, jwtListToAddressData, tgUserNewAddress,
    unbindTelegramAddress } from './common';
import type { CommandContext, CommandReply, ConversationCommand, Params, Prompt } from './conversation';

export const TELEGRAM_COMMANDS = [
    { command: 'start', description: '开始使用 | Get started' },
    { command: 'new', description: '新建邮箱 | Create an address, /new [name][@domain]' },
    { command: 'address', description: '查看邮箱列表 | List addresses' },
    { command: 'bind', description: '绑定邮箱 | Bind an address, /bind [credential]' },
    { command: 'unbind', description: '解绑邮箱 | Unbind an address, /unbind [address]' },
    { command: 'delete', description: '删除邮箱 | Delete an address, /delete [address]' },
    { command: 'mails', description: '查看邮件 | View mail, /mails [address]' },
    { command: 'cleaninvalidaddress', description: '清理无效地址 | Clean invalid addresses' },
    { command: 'lang', description: '设置语言 | Set language, /lang [zh|en]' },
    { command: 'cancel', description: '取消当前操作 | Cancel the current operation' },
];

const bindingKey = (userId: string) => `${CONSTANTS.TG_KV_PREFIX}:${userId}`;
const inputAddress = (msgs: CommandContext['msgs'], text = msgs.TgPleaseInputAddressMsg) =>
    ({ kind: 'input' as const, field: 'address', text });
const options = (values: string[]) => values.map(value => ({ label: value, value }));
const validAddress = (value: string) => /^[^\s@]+@[^\s@]+$/.test(value);

function inputCredential(msgs: CommandContext['msgs'], text = msgs.TgPleaseInputCredentialMsg): Prompt {
    return { kind: 'input', text, field: 'credential' };
}

async function addressChoices(c: Context<HonoCustomType>, { userId, msgs }: CommandContext) {
    const list = await c.env.KV.get<string[]>(bindingKey(userId), 'json') || [];
    const { addressIdMap } = await jwtListToAddressData(c, list, msgs);
    return addressIdMap;
}

function parseNew(payload: string): Params {
    if (!payload) return {};
    const separator = payload.indexOf('@');
    if (separator < 0) return { name: payload, domain: '' };
    const domain = payload.slice(separator + 1).trim();
    const name = payload.slice(0, separator).trim();
    return domain ? { name, domain } : { name, mode: name ? 'custom' : 'domain' };
}

export function getTelegramCommands(c: Context<HonoCustomType>) {
    return TELEGRAM_COMMANDS.filter(cmd => cmd.command !== 'lang' || getBooleanValue(c.env.TG_ALLOW_USER_LANG));
}

export function telegramCommandHandlers(
    c: Context<HonoCustomType>,
    queryMail: (context: CommandContext, address: string, index: number) => Promise<CommandReply>,
): Record<string, ConversationCommand> {
    const businessMessages = i18n.getMessagesbyContext(c);
    const withCreationDomain = async (context: CommandContext, text = context.msgs.TgConversationChooseDomainMsg): Promise<Prompt> => {
        const domains = await getAllowDomains(c);
        return { kind: 'selection', field: 'domain', text,
            options: [{ label: context.msgs.TgConversationDefaultDomainMsg, value: '' }, ...options(domains)] };
    };

    const addressPrompt = (command: string) => async (params: Params, context: CommandContext): Promise<Prompt | undefined> => {
        const { msgs } = context;
        if (params.address && !validAddress(params.address)) {
            delete params.address;
            return inputAddress(msgs, `${msgs.TgInvalidAddressMsg}\n${msgs.TgPleaseInputAddressMsg}`);
        }
        const addressIdMap = await addressChoices(c, context);
        if (params.address) {
            const address = normalizeAddressDomain(params.address);
            const id = addressIdMap[address];
            if (!id) {
                delete params.address;
                return inputAddress(msgs, `${command === 'mails' ? msgs.TgNotBoundAddressMsg : msgs.TgAddressNotYoursMsg}\n${msgs.TgPleaseInputAddressMsg}`);
            }
            params.address = address;
            if (command === 'delete') {
                params.addressId = String(id);
                return { kind: 'confirmation', text: msgs.TgConversationDeletePromptMsg.replace('{address}', address) };
            }
            return;
        }
        if (params.address === '' && command === 'mails') return;
        const addresses = Object.keys(addressIdMap);
        if (!addresses.length) return command === 'mails' ? undefined : inputAddress(msgs);
        const text = command === 'delete' ? msgs.TgConversationChooseDeleteMsg : msgs.TgConversationChooseAddressMsg;
        return { kind: 'selection', field: 'address', text, manual: inputAddress(msgs),
            options: [...(command === 'mails' ? [{ label: msgs.TgConversationFirstMailboxMsg, value: '' }] : []), ...options(addresses)] };
    };

    const externalAddress = (payload: string): Params => payload ? { address: payload } : {};
    const getList = async (userId: string) => await c.env.KV.get<string[]>(bindingKey(userId), 'json') || [];
    const listReply = (title: string, list: string[], msgs: CommandContext['msgs']): CommandReply => ({
        text: `${title}\n\n${list.map(a => `${msgs.TgAddressMsg} ${a}`).join('\n')}`.slice(0, 4096),
    });

    return {
        start: {
            execute: async (_params, { msgs }) => {
                const prefix = trimLower(c.env.PREFIX);
                return { text: `${msgs.TgWelcomeMsg}\n\n`
                    + (prefix ? `${msgs.TgCurrentPrefixMsg} ${prefix}\n` : '')
                    + `${msgs.TgCurrentDomainsMsg} ${JSON.stringify(getDomains(c))}\n`
                    + `${msgs.TgAvailableCommandsMsg}\n`
                    + getTelegramCommands(c).map(cmd => `/${cmd.command}: ${cmd.description}`).join('\n') };
            },
        },
        new: {
            parse: parseNew,
            prompt: async (params, context) => {
                const { msgs } = context;
                if (params.domain !== undefined || params.mode === 'random') return;
                if (!params.mode) {
                    return { kind: 'selection', field: 'mode', text: msgs.TgConversationNewModeMsg,
                        options: [
                            { label: msgs.TgConversationRandomMsg, value: 'random' },
                            ...(!getBooleanValue(c.env.DISABLE_CUSTOM_ADDRESS_NAME)
                                ? [{ label: msgs.TgConversationCustomNameMsg, value: 'custom' }] : []),
                            { label: msgs.TgConversationRandomDomainMsg, value: 'domain' },
                        ] };
                }
                if (params.mode === 'custom' && !params.name?.replace(getNameRegex(c), '').trim()) {
                    const text = params.name
                        ? `${msgs.InvalidInputMsg}\n${msgs.TgConversationNameInputMsg}`
                        : msgs.TgConversationNameInputMsg;
                    delete params.name;
                    return { kind: 'input', field: 'name', text };
                }
                if (params.name) params.name = params.name.replace(getNameRegex(c), '');
                return withCreationDomain(context);
            },
            execute: async (params, context): Promise<CommandReply> => {
                const { name = '', domain = '' } = params;
                const { userId, msgs } = context;
                try {
                    if (domain.includes('@')) throw new Error(businessMessages.InvalidDomainMsg);
                    const res = await tgUserNewAddress(c, userId, domain ? `${name}@${domain}` : name, msgs);
                    return { text: `${msgs.TgCreateSuccessMsg}\n${msgs.TgAddressMsg} ${res.address}\n`
                        + (res.password ? `${msgs.TgPasswordMsg} \`${res.password}\`\n` : '')
                        + `${msgs.TgCredentialMsg} \`${res.jwt}\`\n`, parse_mode: 'Markdown' };
                } catch (error) {
                    const msg = (error as Error).message;
                    if (msg === businessMessages.InvalidDomainMsg) {
                        return { text: msgs.InvalidDomainMsg, retry: await withCreationDomain(context, `${msgs.InvalidDomainMsg}\n${msgs.TgConversationChooseDomainMsg}`),
                            retryParams: { name, mode: name ? 'custom' : 'domain' } };
                    }
                    if (msg === businessMessages.AddressAlreadyExistsMsg || msg === msgs.TgMaxAddressReachedMsg) {
                        return { text: `${msgs.TgCreateFailedMsg} ${msg === msgs.TgMaxAddressReachedMsg ? msg : msgs.AddressAlreadyExistsMsg}` };
                    }
                    if ([businessMessages.NameTooShortMsg, businessMessages.NameTooLongMsg].some(text => msg.startsWith(text))) {
                        return { text: msgs.InvalidInputMsg,
                            retry: { kind: 'input', field: 'name', text: `${msgs.InvalidInputMsg}\n${msgs.TgConversationNameInputMsg}` },
                            retryParams: { mode: 'custom', domain } };
                    }
                    throw error;
                }
            },
        },
        bind: {
            parse: (payload): Params => payload ? { credential: payload } : {},
            prompt: async ({ credential }, { msgs }) => credential ? undefined : inputCredential(msgs),
            execute: async ({ credential }, { userId, msgs }) => {
                const text = `${msgs.TgBindFailedMsg} ${msgs.TgInvalidCredentialMsg}`;
                try {
                    const address = await bindTelegramAddress(c, userId, credential, msgs);
                    return { text: `${msgs.TgBindSuccessMsg}\n${msgs.TgAddressMsg} ${address}` };
                } catch (error) {
                    if ((error as Error).message === msgs.TgMaxAddressReachedCleanMsg) {
                        return { text: `${msgs.TgBindFailedMsg} ${msgs.TgMaxAddressReachedCleanMsg}` };
                    }
                    if ((error as Error).name?.startsWith('Jwt') || (error as Error).message === businessMessages.InvalidAddressCredentialMsg) {
                        return { text, retry: inputCredential(msgs, `${text}\n${msgs.TgPleaseInputCredentialMsg}`) };
                    }
                    throw error;
                }
            },
        },
        unbind: {
            parse: externalAddress,
            prompt: addressPrompt('unbind'),
            execute: async ({ address }, { userId, msgs }) => {
                try {
                    await unbindTelegramAddress(c, userId, address);
                } catch (error) {
                    if ((error as Error).message !== businessMessages.TgAddressNotYoursMsg) throw error;
                    return { text: `${msgs.TgUnbindFailedMsg} ${msgs.TgAddressNotYoursMsg}` };
                }
                return { text: `${msgs.TgUnbindSuccessMsg}\n${msgs.TgAddressMsg} ${address}` };
            },
        },
        delete: {
            parse: externalAddress,
            allowed: ({ msgs }) => !getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL) ? msgs.UserDeleteEmailDisabledMsg : undefined,
            prompt: addressPrompt('delete'),
            execute: async ({ address, addressId }, { userId, msgs }) => {
                try {
                    await deleteTelegramAddress(c, userId, address, msgs, Number(addressId));
                } catch (error) {
                    const msg = (error as Error).message;
                    if (msg === msgs.TgAddressNotYoursMsg || msg === businessMessages.AddressNotFoundMsg) {
                        return { text: `${msgs.TgDeleteFailedMsg} ${msg === msgs.TgAddressNotYoursMsg ? msg : msgs.AddressNotFoundMsg}` };
                    }
                    if (msg === businessMessages.UserDeleteEmailDisabledMsg) return { text: msgs.UserDeleteEmailDisabledMsg };
                    throw error;
                }
                return { text: `${msgs.TgDeleteSuccessMsg} ${address}` };
            },
        },
        mails: {
            parse: externalAddress,
            prompt: addressPrompt('mails'),
            execute: async ({ address }, context) => queryMail(context, address || '', 0),
        },
        address: {
            execute: async (_params, { userId, msgs }) => {
                const { addressList } = await jwtListToAddressData(c, await getList(userId), msgs);
                return listReply(msgs.TgAddressListMsg, addressList, msgs);
            },
        },
        cleaninvalidaddress: {
            execute: async (_params, { userId, msgs }) => {
                const list = await getList(userId);
                const { addressList, invalidJwtList, addressIdMap } = await jwtListToAddressData(c, list, msgs);
                if (invalidJwtList.length) {
                    await c.env.KV.put(bindingKey(userId), JSON.stringify(list.filter(jwt => !invalidJwtList.includes(jwt))));
                }
                return listReply(`${msgs.TgCleanSuccessMsg}\n\n${msgs.TgCurrentAddressListMsg}`,
                    addressList.filter(address => address in addressIdMap), msgs);
            },
        },
        lang: {
            parse: payload => ({ lang: payload.toLowerCase() }),
            allowed: ({ msgs }) => !getBooleanValue(c.env.TG_ALLOW_USER_LANG) ? msgs.TgLangFeatureDisabledMsg : undefined,
            prompt: async ({ lang }, { userId, msgs }) => {
                if (lang === 'zh' || lang === 'en') return;
                const current = await c.env.KV.get(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`);
                return { kind: 'selection', field: 'lang',
                    text: `${lang ? `${msgs.InvalidInputMsg}\n` : ''}${msgs.TgCurrentLangMsg} ${current || 'auto'}\n${msgs.TgSelectLangMsg}`,
                    options: [{ label: '中文', value: 'zh' }, { label: 'English', value: 'en' }] };
            },
            execute: async ({ lang }, { userId, msgs }) => {
                await c.env.KV.put(`${CONSTANTS.TG_KV_PREFIX}:lang:${userId}`, lang);
                return { text: `${msgs.TgLangSetSuccessMsg} ${lang === 'zh' ? '中文' : 'English'}` };
            },
        },
    };
}
