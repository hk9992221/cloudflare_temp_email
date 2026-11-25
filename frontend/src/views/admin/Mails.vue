<script setup>
import { ref, onMounted, watch } from 'vue';
import { useScopedI18n } from '@/i18n/app'

import { useGlobalState } from '../../store'
import { api } from '../../api'
import MailBox from '../../components/MailBox.vue';

const { adminMailTabAddress } = useGlobalState()

const { t } = useScopedI18n('views.admin.Mails')

const mailBoxKey = ref("")

const queryMail = () => {
    adminMailTabAddress.value = adminMailTabAddress.value.trim();
    mailBoxKey.value = Date.now();
}

const fetchMailDetail = id => api.fetch(`/admin/mails/${id}`, { showLoading: false });
const fetchRawMail = id => api.fetch(`/admin/mails/${id}?download=eml`,
    { showLoading: false, responseType: 'blob' });

const fetchMailData = async (limit, offset, summary) => {
    return await api.fetch(
        `/admin/mails`
        + `?limit=${limit}`
        + `&offset=${offset}&summary=${summary}`
        + (adminMailTabAddress.value ? `&address=${adminMailTabAddress.value}` : '')
    );
}

const deleteMail = async (curMailId) => {
    await api.fetch(`/admin/mails/${curMailId}`, { method: 'DELETE' });
};
</script>

<template>
    <div style="margin-top: 10px;">
        <n-input-group>
            <n-input v-model:value="adminMailTabAddress" :placeholder="t('addressQueryTip')"
                @keydown.enter="queryMail" clearable />
            <n-button @click="queryMail" type="primary" tertiary>
                {{ t('query') }}
            </n-button>
        </n-input-group>
        <div style="margin-top: 10px;"></div>
        <MailBox :key="mailBoxKey" :enableUserDeleteEmail="true" :fetchMailData="fetchMailData"
            :fetchMailDetail="fetchMailDetail" :fetchRawMail="fetchRawMail"
            :deleteMail="deleteMail" :showFilterInput="true" />
    </div>
</template>
