<script setup>
import { computed, onMounted, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { api } from '../../api';
import { useScopedI18n } from '@/i18n/app';

const { t } = useScopedI18n('views.admin.MailStorageManager');
const message = useMessage();
const status = ref(null);
const result = ref('');
const busy = ref(false);
const job = computed(() => status.value?.migration?.job);
const available = computed(() => status.value?.bindingConfigured && status.value?.schemaReady);
const display = value => value ?? t('unknown');

async function refresh() {
    status.value = await api.fetch('/admin/mail_storage', { showLoading: false });
}

async function run(path, body, describe) {
    busy.value = true;
    result.value = '';
    try {
        const data = await api.fetch(`/admin/mail_storage${path}`, body ? {
            method: 'POST', body, showLoading: false,
        } : { showLoading: false });
        if (describe) result.value = describe(data);
        await refresh();
    } catch (error) {
        message.error(error.message);
    } finally {
        busy.value = false;
    }
}

function migrate(action) {
    const descriptions = {
        preview: data => t('previewResult', { count: data.eligible, bytes: display(data.d1PayloadBytes) }),
        next: data => t('batchResult', data),
        restart: data => t('batchResult', data),
        retry: data => t('batchResult', data),
    };
    return run('/migrate', { action }, descriptions[action]);
}

function check() {
    return run('/check', undefined, data => data.error || t(data.schemaReady ? 'ready' : 'schemaRequired'));
}

function collect(retryFailed) {
    return run('/gc', { retryFailed }, data => t('gcResult', data));
}

onMounted(() => refresh().catch(error => message.error(error.message)));
</script>

<template>
    <n-card :title="t('title')" embedded :bordered="false" class="mail-storage">
        <n-space vertical v-if="status">
            <n-alert v-if="!status.schemaReady" type="warning">{{ t('schemaRequired') }}</n-alert>
            <n-alert v-else-if="!status.configurationValid || (status.mode === 'r2' && !status.bindingConfigured)"
                type="error">{{ t('configurationError') }}</n-alert>
            <n-descriptions label-placement="left" size="small" :column="1" bordered>
                <n-descriptions-item :label="t('writeMode')">{{ status.mode }}</n-descriptions-item>
                <n-descriptions-item :label="t('binding')">
                    {{ t(status.bindingConfigured ? 'bound' : 'unbound') }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('mailCount')">
                    D1 {{ display(status.d1) }} · R2 {{ display(status.r2) }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('migrationPending')">{{ display(status.pendingMigration) }}</n-descriptions-item>
                <n-descriptions-item :label="t('rawBytes')">
                    {{ display(status.knownRawBytes) }}
                    {{ t('unknownCount', { count: display(status.unknownRawSizeCount) }) }}
                </n-descriptions-item>
                <n-descriptions-item :label="t('r2Bytes')">{{ display(status.r2StoredBytes) }}</n-descriptions-item>
                <n-descriptions-item :label="t('gcPending')">
                    {{ display(status.gcPending) }} · {{ t('gcFailures', { count: display(status.gcFailed) }) }}
                </n-descriptions-item>
            </n-descriptions>
            <n-text depth="3">{{ t('sizeNote') }}</n-text>
            <n-space>
                <n-button :disabled="busy" @click="check">{{ t('check') }}</n-button>
                <n-button :disabled="busy || !status.schemaReady" @click="migrate('preview')">{{ t('preview') }}</n-button>
                <n-popconfirm v-for="action in ['next', 'restart', 'retry']" :key="action"
                    @positive-click="migrate(action)">
                    <template #trigger>
                        <n-button :disabled="busy || !available || !!job?.paused
                            || (action === 'retry' && !status.migration?.failed)">{{ t(action) }}</n-button>
                    </template>
                    {{ t('migrationConfirm') }}
                </n-popconfirm>
                <n-button v-if="job" :disabled="busy" @click="migrate(job.paused ? 'resume' : 'pause')">
                    {{ t(job.paused ? 'resume' : 'pause') }}
                </n-button>
                <n-popconfirm v-for="retryFailed in [false, true]" :key="retryFailed" @positive-click="collect(retryFailed)">
                    <template #trigger>
                        <n-button :disabled="busy || !available || (retryFailed && !status.gcFailed)">
                            {{ t(retryFailed ? 'gcRetry' : 'gc') }}
                        </n-button>
                    </template>
                    {{ t('gcConfirm') }}
                </n-popconfirm>
            </n-space>
            <n-alert v-if="result" type="info">{{ result }}</n-alert>
            <n-text v-if="job">{{ t('progress', { ...job, failed: status.migration.failed }) }}</n-text>
            <n-table v-if="status.migration?.failures.length" size="small">
                <thead><tr><th>{{ t('mailId') }}</th><th>{{ t('failure') }}</th><th>{{ t('attempts') }}</th></tr></thead>
                <tbody><tr v-for="row in status.migration.failures" :key="row.mail_id">
                    <td>{{ row.mail_id }}</td><td>{{ row.error_code }}</td><td>{{ row.attempts }}</td>
                </tr></tbody>
            </n-table>
        </n-space>
    </n-card>
</template>

<style scoped>
.mail-storage {
    max-width: 800px;
    text-align: left;
}
</style>
