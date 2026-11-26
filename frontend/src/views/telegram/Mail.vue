<script setup>
import { useRoute } from 'vue-router'
import { useScopedI18n } from '@/i18n/app'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { processItem, releaseMailAttachments } from '../../utils/email-parser'
import { blockRemoteContent } from '../../utils/remote-content-policy'
import { utcToLocalDate } from '../../utils';

const { telegramApp, loading, useUTCDate } = useGlobalState()
const route = useRoute()
const { t } = useScopedI18n('components.MailContentRenderer')

const curMail = ref({});
const mailHtml = computed(() => blockRemoteContent(curMail.value.message, { allowRemoteImages: true }).html);
let mailRequest = 0;
watch(curMail, (_current, previous) => releaseMailAttachments(previous));

watch(telegramApp, async () => {
    if (telegramApp.value.initData) {
        await fetchMailData();
    }
});

const fetchMailData = async () => {
    const request = ++mailRequest;
    try {
        const credentials = {
            method: 'POST',
            body: JSON.stringify({ initData: telegramApp.value.initData, mailId: route.query.mail_id }),
        };
        const res = await api.fetch('/telegram/get_mail', credentials);
        if (!res || request !== mailRequest) return;
        const raw = await api.fetch('/telegram/get_mail?download=eml', { ...credentials, responseType: 'blob' });
        const mail = await processItem(res, await raw.arrayBuffer());
        if (request !== mailRequest) {
            releaseMailAttachments(mail);
            return;
        }
        curMail.value = mail;
    }
    catch (error) {
        console.error(error);
        return {};
    }
    finally {
        loading.value = false;
    }
};

onMounted(fetchMailData);
onBeforeUnmount(() => {
    mailRequest++;
    releaseMailAttachments(curMail.value);
});
</script>

<template>
    <div class="center">
        <n-card :bordered="false" embedded v-if="curMail.message" style="max-width: 800px; height: 100%;">
            <n-tag type="info">
                ID: {{ curMail.id }}
            </n-tag>
            <n-tag type="info">
                Date: {{ utcToLocalDate(curMail.created_at, useUTCDate) }}
            </n-tag>
            <n-tag type="info">
                FROM: {{ curMail.source }}
            </n-tag>
            <n-tag v-if="curMail.alias_tag" type="info">
                {{ t('mailbox') }} · {{ curMail.address }}
            </n-tag>
            <n-tag v-if="curMail.alias_tag" type="info">
                {{ t('originalRecipient') }} · {{ curMail.original_recipient }}
            </n-tag>
            <n-tag v-if="curMail.alias_tag" type="info">
                +{{ curMail.alias_tag }}
            </n-tag>
            <iframe :srcdoc="mailHtml" sandbox="allow-same-origin allow-popups"
                style="margin-top: 10px;width: 100%; height: 100%;">
            </iframe>
        </n-card>
    </div>
</template>


<style scoped>
.center {
    display: flex;
    text-align: left;
    place-items: center;
    justify-content: center;
    height: 80vh;
}
</style>
