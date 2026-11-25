import { RawMailRow } from "../models";
import { Context } from "hono";
import i18n from "../i18n";
import { handleMailListQuery } from "../common";
import { downloadRawMail, resolveRawEmailRow } from "../email/storage/read";
import { getBooleanValue } from "../utils";

export default {
    getMails: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const { address, limit, offset } = c.req.query();
        const filterQuerys = [`ua.user_id = ?`];
        const filterParams = [String(user_id)];
        if (address) {
            filterQuerys.push(`rm.address = ?`);
            filterParams.push(address);
        }
        const fromQuery = ` FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` JOIN raw_mails rm ON rm.address = a.name`
            + ` WHERE ${filterQuerys.join(" AND ")}`;
        return await handleMailListQuery(c,
            `SELECT rm.*${fromQuery}`,
            `SELECT count(*) as count${fromQuery}`,
            filterParams, limit, offset, 'rm.id desc'
        );
    },
    getMail: async (c: Context<HonoCustomType>) => {
        const { user_id } = c.get("userPayload");
        const row = await c.env.DB.prepare(`SELECT rm.* FROM raw_mails rm
            JOIN address a ON a.name = rm.address
            JOIN users_address ua ON ua.address_id = a.id
            WHERE rm.id = ? AND ua.user_id = ?`).bind(c.req.param('id'), user_id).first<RawMailRow>();
        if (!row) return c.json(null, 404);
        return c.req.query('download') === 'eml'
            ? downloadRawMail(c.env, row)
            : c.json(await resolveRawEmailRow(c.env, row));
    },
    deleteMail: async (c: Context<HonoCustomType>) => {
        const msgs = i18n.getMessagesbyContext(c);
        if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
            return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
        }
        const { id } = c.req.param();
        const { user_id } = c.get("userPayload");
        const { success } = await c.env.DB.prepare(
            `DELETE FROM raw_mails WHERE id = ?`
            + ` AND EXISTS (`
            + `SELECT 1 FROM users_address ua`
            + ` JOIN address a ON a.id = ua.address_id`
            + ` WHERE ua.user_id = ? AND a.name = raw_mails.address`
            + `)`
        ).bind(id, user_id).run();
        return c.json({
            success: success
        })
    }
}
