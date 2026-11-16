<script setup lang="ts">
import { computed } from 'vue'
import type { Page } from '../api/types'

export type IconName = Page | 'arrow' | 'check' | 'chevron' | 'close' | 'copy' | 'document' | 'download' | 'external' | 'eye' | 'eye-off' | 'refresh' | 'plus' | 'send' | 'settings' | 'shield' | 'sparkle' | 'trash' | 'clock' | 'warning' | 'lock' | 'edit' | 'filter' | 'menu'

const props = defineProps<{ name: IconName; size?: number }>()
const size = computed(() => props.size ?? 20)
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'conversation'"><path d="M19 11.5a7 7 0 0 1-7 7H6l-3 2 1-4.2a7.5 7.5 0 1 1 15-4.8Z"/><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01" stroke-width="2.6"/></template>
    <template v-else-if="name === 'activity'"><path d="M3 12h4l3-7 4 14 3-7h4"/></template>
    <template v-else-if="name === 'devices'"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 8l3 2-3 2M12 12h4"/></template>
    <template v-else-if="name === 'projects'"><path d="m3 7 9-4 9 4-9 4-9-4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/></template>
    <template v-else-if="name === 'memories'"><path d="M13 4a7 7 0 0 0-4 12.5V21l3-1 3 1v-2a7 7 0 0 0-2-15Z"/><path d="m9 10 2 2 4-4"/></template>
    <template v-else-if="name === 'access' || name === 'shield'"><path d="m12 3 8 4v5c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V7l8-4Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/></template>
    <template v-else-if="name === 'help'"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 17h.01" stroke-width="2"/></template>
    <template v-else-if="name === 'arrow'"><path d="M5 12h14m-5-5 5 5-5 5"/></template>
    <template v-else-if="name === 'check'"><path d="m5 12 4 4L19 6"/></template>
    <template v-else-if="name === 'chevron'"><path d="m8 10 4 4 4-4"/></template>
    <template v-else-if="name === 'close'"><path d="m6 6 12 12M6 18 18 6"/></template>
    <template v-else-if="name === 'copy'"><rect x="8" y="8" width="11" height="13" rx="2"/><path d="M15 5V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1"/></template>
    <template v-else-if="name === 'document'"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></template>
    <template v-else-if="name === 'download'"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></template>
    <template v-else-if="name === 'external'"><path d="M13 5h6v6m0-6-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></template>
    <template v-else-if="name === 'eye'"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></template>
    <template v-else-if="name === 'eye-off'"><path d="m3 3 18 18M10.5 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3m-3 2.3a10 10 0 0 1-4 .7C5.5 18 2 12 2 12a17 17 0 0 1 4-5M10 10a3 3 0 0 0 4 4"/></template>
    <template v-else-if="name === 'refresh'"><path d="M20 7v5h-5M4 17v-5h5M5.2 8A7 7 0 0 1 17 5l3 4M4 16l3 4a7 7 0 0 0 11.8-3"/></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14M5 12h14"/></template>
    <template v-else-if="name === 'send'"><path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14"/></template>
    <template v-else-if="name === 'settings'"><path d="M4 6h10m4 0h2M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></template>
    <template v-else-if="name === 'sparkle'"><path d="m12 3 2 6 6 3-6 2-2 7-2-7-6-2 6-3 2-6ZM20 2v4m-2-2h4"/></template>
    <template v-else-if="name === 'trash'"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></template>
    <template v-else-if="name === 'clock'"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></template>
    <template v-else-if="name === 'warning'"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01" stroke-width="2"/></template>
    <template v-else-if="name === 'lock'"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></template>
    <template v-else-if="name === 'edit'"><path d="m14 5 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15l1 5Z"/></template>
    <template v-else-if="name === 'filter'"><path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/></template>
    <template v-else-if="name === 'menu'"><path d="M4 7h16M4 12h16M4 17h16"/></template>
  </svg>
</template>
