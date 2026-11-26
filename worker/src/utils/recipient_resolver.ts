import type { Context } from 'hono';
import { CONSTANTS } from '../constants';
import type { EmailRuleSettings } from '../models';
import { getBooleanValue, getJsonSetting, normalizeAddressDomain } from '../utils';

export function plusAddressingStatus(env: Pick<Bindings, 'ENABLE_PLUS_ADDRESSING'>, rules?: EmailRuleSettings | null) {
    const envConfigured = env.ENABLE_PLUS_ADDRESSING != null;
    const envEnabled = getBooleanValue(env.ENABLE_PLUS_ADDRESSING);
    const locked = envConfigured && !envEnabled;
    return { locked, enabled: !locked && (rules?.enablePlusAddressing ?? envEnabled) === true };
}

export const getEmailRules = (c: Context<HonoCustomType>) =>
    getJsonSetting<EmailRuleSettings>(c, CONSTANTS.EMAIL_RULE_SETTINGS_KEY);

// Limit alias routing to unquoted SMTP dot-atom addresses. The complete
// mailbox lookup remains compatible with other historical address formats.
export function splitPlusRecipient(address: string) {
    if (address.length > 254 || /[^\x21-\x7e]/.test(address)) return null;
    const parts = address.split('@');
    if (parts.length !== 2) return null;
    const [local, domain] = parts;
    const plus = local.indexOf('+');
    if (plus <= 0 || plus === local.length - 1 || local.length > 64) return null;
    const dotAtom = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
    const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    if (!dotAtom.test(local) || !dotAtom.test(local.slice(0, plus)) || !dotAtom.test(local.slice(plus + 1))
        || !domain.split('.').every(part => label.test(part))) return null;
    return { address: normalizeAddressDomain(`${local.slice(0, plus)}@${domain}`), tag: local.slice(plus + 1) };
}

export async function resolveIncomingRecipient(env: Bindings, original: string, enabled: boolean, checkUnknown = false) {
    const normalized = normalizeAddressDomain(original);
    const alias = enabled ? splitPlusRecipient(original) : null;
    const direct = { original, normalized, address: normalized, tag: null as string | null, known: null as boolean | null };
    if (!alias && !checkUnknown) return direct;
    const exists = (address: string) => env.DB.prepare('SELECT id FROM address WHERE name = ?')
        .bind(address).first<number>('id');
    if (await exists(normalized)) return { ...direct, known: true };
    if (alias && await exists(alias.address)) return { ...direct, ...alias, known: true };
    return { ...direct, known: false };
}

export function recipientMetadata(address: string, original: string, tag: string | null) {
    return { original_recipient: original, mailbox_address: address, alias_tag: tag, is_plus_alias: tag !== null };
}
