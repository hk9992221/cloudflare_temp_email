<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useScopedI18n } from '@/i18n/app'

const props = defineProps({
    fetchMails: { type: Function, required: true },
    unreadEnabled: Boolean,
    refreshVersion: { type: Number, default: 0 }
})
const emits = defineEmits(['change'])
const { t } = useScopedI18n('components.AliasFilter')
const selection = ref('all')
const unread = ref(false)
const tags = ref([])
const loading = ref(false)
const failed = ref(false)
let request = 0

const options = computed(() => [
    { label: t('all'), value: 'all' },
    { label: t('none'), value: 'none' },
    ...tags.value.map(tag => ({ label: `+${tag}`, value: `+${tag}` }))
])

const filterOption = (pattern, option) =>
    String(option.label).toLowerCase().includes(pattern.toLowerCase())

const change = () => {
    const value = selection.value
    emits('change', {
        ...(value === 'none' ? { alias: 'none' } : {}),
        ...(value.startsWith('+') ? { aliasTag: value.slice(1) } : {}),
        ...(unread.value ? { unread: 'true' } : {})
    })
}

const load = async () => {
    const id = ++request
    loading.value = true
    failed.value = false
    try {
        const values = new Set()
        const limit = 100
        let offset = 0
        let total = 0
        do {
            const { results, count } = await props.fetchMails(limit, offset, true, { aliasTags: 'true' })
            if (id !== request) return
            if (!Array.isArray(results) || (offset === 0 && !Number.isFinite(Number(count)))) {
                throw new Error('Invalid alias tag response')
            }
            if (offset === 0) total = Number(count)
            for (const row of results) {
                if (typeof row.alias_tag === 'string' && row.alias_tag) values.add(row.alias_tag)
            }
            offset += results.length
            if (!results.length) break
        } while (offset < total)
        if (id !== request) return
        tags.value = [...values]
        if (selection.value.startsWith('+') && !values.has(selection.value.slice(1))) {
            selection.value = 'all'
            change()
        }
    } catch {
        if (id === request) failed.value = true
    } finally {
        if (id === request) loading.value = false
    }
}

const selectTag = tag => {
    if (!tag) return
    if (!tags.value.includes(tag)) tags.value = [...tags.value, tag]
    selection.value = '+' + tag
    change()
}
defineExpose({ selectTag })
watch(() => props.refreshVersion, load, { immediate: true })
onBeforeUnmount(() => { request++ })
</script>

<template>
    <n-flex align="center">
        <n-select v-model:value="selection" :options="options" :loading="loading"
            :placeholder="t('filter')" :aria-label="t('filter')" :aria-description="t('search')"
            style="width: 200px" filterable :filter="filterOption" size="small"
            @update:show="show => show && !loading && load()" @update:value="change" />
        <n-checkbox v-if="unreadEnabled" v-model:checked="unread" @update:checked="change">
            {{ t('unread') }}
        </n-checkbox>
        <n-text v-if="failed" type="error">{{ t('failed') }}</n-text>
    </n-flex>
</template>
