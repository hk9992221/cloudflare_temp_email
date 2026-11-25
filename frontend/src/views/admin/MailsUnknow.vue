<script setup>
import { api } from '../../api'
import MailBox from '../../components/MailBox.vue';

const fetchRawMail = id => api.fetch(`/admin/mails/${id}?download=eml`,
    { showLoading: false, responseType: 'blob' });

const fetchMailUnknowData = async (limit, offset, summary) => {
    return await api.fetch(
        `/admin/mails_unknow`
        + `?limit=${limit}`
        + `&offset=${offset}&summary=${summary}`
    );
}

const deleteMail = async (curMailId) => {
    await api.fetch(`/admin/mails/${curMailId}`, { method: 'DELETE' });
};
</script>

<template>
    <div style="margin-top: 10px;">
        <MailBox :enableUserDeleteEmail="true" :fetchMailData="fetchMailUnknowData"
            :fetchRawMail="fetchRawMail" :deleteMail="deleteMail" />
    </div>
</template>
