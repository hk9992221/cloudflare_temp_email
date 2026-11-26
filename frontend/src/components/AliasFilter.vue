<script setup>
import { computed, ref } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useScopedI18n } from '@/i18n/app'

const props = defineProps({ fetchMails: { type: Function, required: true }, unreadEnabled: Boolean })
const emits = defineEmits(['change'])
const { t } = useScopedI18n('components.AliasFilter')
const selection = ref('all')
const unread = ref(false)
const tags = ref([])
const loading = ref(false)
const failed = ref(false)
let request = 0
const options = computed(() => {
    const values = new Set(tags.value)
    if (selection.value.startsWith('+')) values.add(selection.value.slice(1))
    return [
        { label: t('all'), value: 'all' },
        { label: t('none'), value: 'none' },
        ...[...values].map(tag => ({ label: `+${tag}`, value: `+${tag}` })),
    ]
})
const load = useDebounceFn(async (search, id) => {
    try {
        const { results } = await props.fetchMails(50, 0, true, { aliasTags: 'true', tagSearch: search })
        if (id === request) tags.value = results.flatMap(row => row.alias_tag ? [row.alias_tag] : [])
    } catch {
        if (id === request) failed.value = true
    } finally {
        if (id === request) loading.value = false
    }
}, 180)
const search = (value = '') => {
    loading.value = true
    failed.value = false
    tags.value = []
    void load(value, ++request)
}
const change = () => {
    const value = selection.value
    emits('change', {
        ...(value === 'none' ? { alias: 'none' } : {}),
        ...(value.startsWith('+') ? { aliasTag: value.slice(1) } : {}),
        ...(unread.value ? { unread: 'true' } : {}),
    })
}
</script>

<template>
    <n-flex align="center">
        <n-select v-model:value="selection" :options="options" :loading="loading"
            :placeholder="t('filter')" :aria-label="t('filter')" :aria-description="t('search')"
            style="width: 200px" filterable remote size="small" @search="search"
            @update:show="show => show && search()" @update:value="change" />
        <n-checkbox v-if="unreadEnabled" v-model:checked="unread" @update:checked="change">
            {{ t('unread') }}
        </n-checkbox>
        <n-text v-if="failed" type="error">{{ t('failed') }}</n-text>
    </n-flex>
</template>
