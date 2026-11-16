<script setup lang="ts">
import AppIcon, { type IconName } from './AppIcon.vue'
defineProps<{ icon: IconName; title: string; description: string }>()
</script>

<template>
  <div class="empty-state">
    <span class="empty-icon"><AppIcon :name="icon" :size="26" /></span>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
