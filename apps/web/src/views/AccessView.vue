<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { Grant, GrantOperation, LoomNode, Project } from '../api/types'
import { formatTime } from '../lib/format'
import { grantOperationLabel, selectedGrantOperations } from '../lib/permissions'
import { activeGrantCount, grantStatus, grantStatusLabel } from '../lib/grantStatus'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

defineProps<{ grants: Grant[]; projects: Project[]; nodes: LoomNode[]; busy?: boolean; error?: string }>()
const emit = defineEmits<{ create: [value: { project_id: string; operations: GrantOperation[]; node_id?: string }]; revoke: [grant: Grant] }>()
const form = reactive({ project_id: '', node_id: '', read_summary: true, edit_file: false })
const creating = ref(false)
const reviewedGrant = ref<{ operations: GrantOperation[]; node_id?: string } | null>(null)
function reviewGrant() {
  reviewedGrant.value = {
    node_id: form.node_id || undefined,
    operations: selectedGrantOperations(form.read_summary, form.edit_file),
  }
  emit('create', { project_id: form.project_id, ...reviewedGrant.value })
}
</script>

<template>
  <section class="page-view"><div class="page-title"><span class="eyebrow">PERMISSIONS, CLEARLY</span><h1>每一步，都有你的许可。</h1><p>Grant 是明确的项目授权，不是执行中的 Lease。撤销后会阻止新的工作。</p></div>
    <div class="access-boundary"><AppIcon name="shield" :size="23" /><div><strong>设备有能力 ≠ 设备有权限</strong><p>保存记忆、连接到节点或打开工作空间，都不会自动产生授权。</p></div></div>
    <div class="projects-toolbar"><h2>项目授权 <span class="count-pill">{{ activeGrantCount(grants) }}</span></h2><button class="button primary" :disabled="!projects.length" @click="creating = !creating"><AppIcon name="plus" :size="16" />创建 Grant</button></div>
    <div v-if="creating" class="card grant-form"><h3>创建一个有限授权</h3><form @submit.prevent="reviewGrant"><div class="field"><label for="grant-project">作用项目</label><select id="grant-project" v-model="form.project_id" required><option value="" disabled>请选择项目</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }} · {{ project.mode === 'read_write' ? '读写项目' : '只读项目' }}</option></select></div><div class="field"><label for="grant-node">限定节点 <span class="muted">可选</span></label><select id="grant-node" v-model="form.node_id"><option value="">不限定节点，由协调器按权限匹配</option><option v-for="node in nodes" :key="node.id" :value="node.id">{{ node.name || node.id }}</option></select></div><fieldset class="grant-operations"><legend>允许的操作</legend><label><input v-model="form.read_summary" type="checkbox" :disabled="form.edit_file" />读取项目并生成摘要 · <code>read_summary</code></label><label><input v-model="form.edit_file" type="checkbox" />读取 + 写入 · <code>read_write</code></label><p class="hint">{{ form.edit_file ? 'read_write 同时包含读取和写入，不只是写入。提交 operations: ["read_write"]，服务端规范化为 read + write。' : 'read_summary 是允许读取项目并生成摘要的操作权限；仅发现目录、绑定节点或看到项目记录都不会获得此权限。' }}</p></fieldset><p v-if="reviewedGrant" class="hint" data-test="grant-review">本次提交：node_id={{ reviewedGrant.node_id ?? 'auto' }}；operations={{ JSON.stringify(reviewedGrant.operations) }}。<template v-if="reviewedGrant.operations.includes('read_write')">这包含读取 + 写入；没有已确认位置时会返回服务端绑定错误。</template></p><div class="inline-note warning-note"><AppIcon name="warning" :size="16" />创建后仍需明确确认，节点才可以按授权领取工作。写入范围不越过项目目录。</div><div class="modal-actions"><button type="button" class="button secondary" @click="creating = false">取消</button><button class="button primary" type="submit" :disabled="!form.project_id || (!form.read_summary && !form.edit_file)">检查授权影响</button></div></form></div>
    <div class="grant-list"><EmptyState v-if="!grants.length" icon="access" title="还没有主动创建的授权" description="从项目和最小操作开始。这个项目权限列表不会伪造已有访问。" /><article v-for="grant in grants" :key="grant.id" class="grant-item card"><div class="grant-item-heading"><span class="grant-symbol"><AppIcon name="lock" :size="19" /></span><div><h3>{{ projects.find(p => p.id === grant.project_id)?.name ?? '项目范围' }}</h3><code>{{ grant.id }}</code></div><span class="status-badge" :class="grantStatus(grant) === 'active' ? 'success' : 'neutral'">{{ grantStatusLabel(grant) }}</span></div><div class="grant-scope"><span>操作</span><div class="capability-list"><span v-for="operation in grant.operations" :key="operation">{{ grantOperationLabel(operation) }}</span></div></div><div class="grant-scope"><span>节点</span><strong>{{ grant.node_id === 'auto' ? '由协调器匹配合适的已有绑定' : grant.node_id || '节点未记录' }}<template v-if="grant.worker_id"> · Worker {{ grant.worker_id }}</template></strong></div><div class="grant-item-bottom"><span>版本 {{ grant.version ?? '由服务端维护' }}<template v-if="grant.created_at"> · {{ formatTime(grant.created_at) }}</template></span><button v-if="grantStatus(grant) === 'active'" class="text-link danger-text" :disabled="busy" type="button" @click="emit('revoke', grant)">撤销授权<AppIcon name="arrow" :size="14" /></button></div></article></div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
