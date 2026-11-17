<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { TOKEN_KEY, localRead } from '../lib/storage'
import AppIcon from './AppIcon.vue'

const props = withDefaults(defineProps<{ checking?: boolean; error?: string }>(), { checking: false, error: '' })
const emit = defineEmits<{ saved: [token: string]; close: [] }>()
const value = ref(localRead(TOKEN_KEY) ?? '')
const visible = ref(false)
const attempted = ref(false)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
  if (event.key === 'Tab') {
    const focusable = [...document.querySelectorAll<HTMLElement>('#connection-dialog button, #connection-dialog input')]
    if (!focusable.length) return
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus() }
    if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus() }
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

function save() {
  if (props.checking) return
  attempted.value = true
  emit('saved', value.value.trim())
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <section id="connection-dialog" class="modal connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-heading">
        <div class="modal-top"><span class="modal-icon"><AppIcon name="lock" :size="22" /></span><button class="icon-button" aria-label="关闭连接设置" @click="emit('close')"><AppIcon name="close" /></button></div>
        <h2 id="connection-heading">连接你的工作空间</h2>
        <p class="modal-effect">Loom 连接到你自己的协调器。输入服务器配置的 Client Token 才能读取项目、任务和授权信息。</p>
        <form @submit.prevent="save">
          <div class="field"><label for="client-token">Client Token <span class="muted">Bearer</span></label><div class="token-input"><input id="client-token" v-model="value" :type="visible ? 'text' : 'password'" placeholder="粘贴你的访问令牌" autocomplete="off" spellcheck="false" autofocus /><button type="button" class="icon-button" :aria-label="visible ? '隐藏令牌' : '显示令牌'" @click="visible = !visible"><AppIcon :name="visible ? 'eye-off' : 'eye'" :size="17" /></button></div></div>
          <div class="inline-note security-note"><AppIcon name="shield" :size="17" /><p>仅保存在当前浏览器的 localStorage。不会发送到 Loom 以外的地址。共享设备上请使用无痕窗口或清除令牌。留空则尝试部署环境的现有授权。</p></div>
          <div class="connection-endpoint"><span>API 基址</span><code>/api/v1</code><span class="muted">同源服务</span></div>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <p class="inline-note security-note">不是任务完成回执：只有受保护读取通过后，这里的候选凭据才会保存并恢复工作区。原处运行中的 Worker 不会因更换凭据而自动停止。</p>
          <div class="modal-actions"><button class="button primary" type="submit" :disabled="checking"><AppIcon name="check" :size="17" />{{ checking ? '正在验证连接…' : attempted ? '保存并验证连接' : '保存并重新连接' }}</button></div>
        </form>
      </section>
    </div>
  </Teleport>
</template>
