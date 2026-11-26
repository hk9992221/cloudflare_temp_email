<script setup>
import { computed, ref, watch } from 'vue'
import { useScopedI18n } from '@/i18n/app'

const props = defineProps({ address: { type: String, required: true } })
const { t } = useScopedI18n('components.PlusAlias')
const message = useMessage()
const tag = ref('')
const local = computed(() => props.address.split('@')[0])
const available = computed(() => /^[A-Za-z0-9!#$%&'*\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*\/=?^_`{|}~-]+)*$/.test(local.value)
    && local.value.length < 63 && props.address.length < 253)
const maxLength = computed(() => Math.min(63 - local.value.length, 253 - props.address.length))
const example = computed(() => props.address.replace('@', '+gpt@'))
const alias = computed(() => {
    if (!tag.value || tag.value.length > maxLength.value ||
        !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/.test(tag.value)) return ''
    return props.address.replace('@', () => `+${tag.value}@`)
})
watch(() => props.address, () => { tag.value = '' })

const copy = async () => {
    try {
        await navigator.clipboard.writeText(alias.value)
        message.success(t('copied'))
    } catch {
        message.error(t('copyFailed'))
    }
}
</script>

<template>
    <n-collapse v-if="available" style="margin-top: 8px; text-align: left;">
        <n-collapse-item :title="t('enabled')">
            <n-space vertical>
                <n-text depth="3">{{ t('example', { address: example }) }}</n-text>
                <n-input v-model:value="tag" :placeholder="t('tag')" :aria-label="t('tag')" :maxlength="maxLength"
                    :status="tag && !alias ? 'error' : undefined" clearable />
                <n-text v-if="tag && !alias" type="error">{{ t('invalid') }}</n-text>
                <n-flex v-if="alias" align="center">
                    <n-text code>{{ alias }}</n-text>
                    <n-button size="small" @click="copy">{{ t('copy') }}</n-button>
                </n-flex>
            </n-space>
        </n-collapse-item>
    </n-collapse>
</template>
