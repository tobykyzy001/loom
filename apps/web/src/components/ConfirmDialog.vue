<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import AppIcon from './AppIcon.vue'

export interface Confirmation {
  title: string
  confirmLabel: string
  effect: string
  changes?: string[]
  danger?: boolean
}

const props = defineProps<{ confirmation: Confirmation | null; busy?: boolean; error?: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const button = ref<HTMLButtonElement>()
let previous: HTMLElement | null = null

function onKeydown(event: KeyboardEvent) {
  if (!props.confirmation) return
  if (event.key === 'Escape' && !props.busy) emit('cancel')
  if (event.key === 'Tab') {
    const focusable = [...document.querySelectorAll<HTMLElement>('.confirm-modal button:not(:disabled), .confirm-modal input, .confirm-modal select, .confirm-modal textarea')]
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
}
watch(() => props.confirmation, async value => {
  if (value) {
    previous = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeydown)
    await nextTick()
    button.value?.focus()
  } else {
    document.removeEventListener('keydown', onKeydown)
    previous?.focus()
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmation" class="modal-backdrop" @click.self="!busy && emit('cancel')">
      <section class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-heading">
        <span class="confirm-symbol" :class="{ danger: confirmation.danger }"><AppIcon :name="confirmation.danger ? 'warning' : 'shield'" :size="25" /></span>
        <h2 id="confirm-heading">{{ confirmation.title }}</h2>
        <p class="modal-effect">{{ confirmation.effect }}</p>
        <div v-if="confirmation.changes?.length" class="effect-box">
          <span class="eyebrow">本次改动</span>
          <ul><li v-for="change in confirmation.changes" :key="change">{{ change }}</li></ul>
        </div>
        <p class="muted small">Loom 不会因对话或节点能力自动获得授权。</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="button secondary" :disabled="busy" @click="emit('cancel')">返回检查</button>
          <button ref="button" class="button primary" :class="{ danger: confirmation.danger }" :disabled="busy" @click="emit('confirm')">
            <span v-if="busy" class="spinner" />{{ busy ? '正在提交…' : confirmation.confirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
