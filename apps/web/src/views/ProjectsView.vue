<script setup lang="ts">
import type { LoomNode, Project, ProjectInventory } from '../api/types'
import { formatTime } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

const props = defineProps<{ projects: Project[]; nodes: LoomNode[]; expanded: boolean; preferencesBusy?: boolean; bindingBusy?: boolean; notice?: string; probeBusy?: Record<string, boolean>; probeErrors?: Record<string, string> }>()
const emit = defineEmits<{ add: []; bind: [project: Project]; probe: [project: Project]; 'create-grant': []; preference: [expanded: boolean, sender: string] }>()
const keyFor = (id: string) => `project-probe:${id}`
const isWorking = (id: string) => props.probeBusy?.[keyFor(id)] === true
const probeError = (id: string) => props.probeErrors?.[keyFor(id)] || ''
function formLabel(inventory: ProjectInventory): string {
  return inventory.form === 'working_tree' ? 'Git 工作树' : inventory.form === 'documents' ? '普通资料目录（非 Git）' : inventory.form === 'generated_workspace' ? '生成的工作区' : `未知记录形式：${inventory.form}`
}
function revisionLabel(inventory: ProjectInventory): string {
  return inventory.revision ?? '未获取有效的 HEAD revision'
}
function dirtyLabel(inventory: ProjectInventory): string {
  if (typeof inventory.dirty !== 'boolean') return '本次未获得工作树修改状态'
  return inventory.dirty ? '有未提交的修改' : 'git status 未显示未提交修改'
}
function remoteLabel(inventory: ProjectInventory): string {
  if (inventory.canonical_remote) return inventory.canonical_remote
  return inventory.canonical_remote_status === 'unsupported_or_redacted' || inventory.needs_review
    ? '已排除不安全或含凭据的远端地址，不以原文替代'
    : '没有可公开的远端地址（不等于远端已连通或不存在）'
}
function credentialLabel(inventory: ProjectInventory): string {
  const location = inventory.credential_location === 'host_credential_store' ? '系统凭据库引用' : inventory.credential_location === 'node_credential_broker' ? '节点凭据 Broker 引用' : (!inventory.credential_location || inventory.credential_location === 'none') ? '未声明凭据存储引用' : '未识别的存储类别（不含密钥内容）'
  const lookup = inventory.credential_lookup_performed
  if (lookup === true) return `${location}；存在凭据查询记录，这不代表已验证凭据或授予访问权`
  if (lookup === false) return `${location}；未执行凭据读取，远端与可用性仍未验证`
  return `${location}；凭据查询状态未知，不推断已可访问远端`
}
function sourceLabel(inventory: ProjectInventory): string {
  return inventory.source === 'controller_probe' ? '控制器本地只读检查' : `来源：${inventory.source ?? '未提供'}（不自动视为当前状态）`
}
</script>

<template>
  <section class="page-view"><div class="page-title"><span class="eyebrow">YOUR WORK DIRECTORIES</span><h1>项目有位置，授权有范围。</h1><p>这里是受控的工作目录，不是通往整台机器的钥匙。</p></div>
    <p v-if="notice" class="inline-note" role="status"><AppIcon name="check" :size="16" /><span>{{ notice }}</span><button class="text-link" @click="emit('create-grant')">前往权限页<AppIcon name="arrow" :size="14" /></button></p>
    <div class="projects-toolbar"><span class="muted small">{{ projects.length }} 个已注册项目</span><button class="button primary" @click="emit('add')"><AppIcon name="plus" :size="16" />添加项目</button></div>
    <EmptyState v-if="!projects.length" class="card" icon="projects" title="从一个真实项目开始" description="输入你已有的目录，并选择最小访问范围。空空的工作空间，不需要用示例填满。"><button class="button primary" @click="emit('add')"><AppIcon name="plus" :size="16" />创建第一个项目</button></EmptyState>
    <div v-else class="project-grid"><article v-for="project in projects" :key="project.id" class="project-card card"><div class="project-card-top"><span class="project-folder"><AppIcon name="projects" :size="24" /></span><span class="status-badge" :class="project.mode === 'read_write' ? 'waiting' : project.mode === 'read_only' ? 'active' : 'neutral'">{{ project.mode === 'read_write' ? '受控读写' : project.mode === 'read_only' ? '只读项目' : `未知模式：${project.mode}` }}</span></div><h2>{{ project.name }}</h2><span class="mono project-id">{{ project.id }}</span><div class="project-scope"><AppIcon :name="project.mode === 'read_write' ? 'edit' : 'eye'" :size="17" /><p>{{ project.mode === 'read_write' ? '可以申请目录内的文件写入，仍需要独立 Grant。' : '只允许授权范围内的读取，不改变原文件。' }}</p></div><div v-if="project.inventory" class="project-inventory">
  <div class="evidence-heading"><AppIcon name="eye" :size="14" /><strong>本地目录观测</strong><span>{{ sourceLabel(project.inventory) }}</span></div>
  <p class="evidence-time">{{ project.inventory.probed_at ? `观测于 ${formatTime(project.inventory.probed_at, true)}` : '未提供检查时间；不据此推断当前状态' }}</p>
  <dl class="inventory-facts">
    <div><dt>目录形态</dt><dd>{{ formLabel(project.inventory) }}</dd></div>
    <template v-if="project.inventory.form === 'working_tree'">
      <div><dt>HEAD（基线，不代表当前工作树与之相同）</dt><dd class="mono wrap-value">{{ revisionLabel(project.inventory) }}</dd></div>
      <div><dt>修改状态</dt><dd>{{ dirtyLabel(project.inventory) }}</dd></div>
    </template>
    <div><dt>远端地址</dt><dd class="mono wrap-value">{{ remoteLabel(project.inventory) }}</dd></div>
    <div><dt>凭据与远端</dt><dd>{{ credentialLabel(project.inventory) }}</dd></div>
  </dl>
  <p class="hint">此处的远端、root和HEAD都是本地受控观测，不是联网通信证明、凭据授权或新 Grant。</p>
</div>
<div v-else class="inline-note"><AppIcon name="help" :size="15" /><span>暂未获得可展示的本地观测。缺少信息不是“目录干净”或“非 Git”的证明；不会虚构 HEAD。</span></div>
<div class="project-refresh"><button class="button secondary" :disabled="isWorking(project.id)" :data-project-probe="project.id" :aria-label="`只读重新读取 ${project.name} 的本地 Git 事实`" @click="emit('probe', project)"><AppIcon name="refresh" :size="14" />{{ isWorking(project.id) ? '正在读取本地事实…' : '重新读取本地事实' }}</button><p v-if="probeError(project.id)" class="form-error" role="alert">刷新未完成，保留原已知观测。{{ probeError(project.id) }}</p><p class="hint">只读检查既有目录，不 clone/fetch、不运行项目、不检查 Credential Store。</p></div>
<div class="project-binding-action"><p v-if="project.root && nodes.length" class="hint">请核对项目根目录，并明确选择节点；绑定后才能创建 Grant。</p><p v-else-if="!project.root" class="hint">服务端未返回项目根目录，无法建立精确绑定。请通过明确配置补齐，不要改选其他目录。</p><p v-else class="hint">尚无已注册节点。请先在设备页注册节点，再进行资源绑定。</p><button class="button secondary" :disabled="!project.root?.trim() || !nodes.length || bindingBusy" @click="emit('bind', project)"><AppIcon name="devices" :size="15" />绑定本地节点资源</button></div><div class="project-card-bottom"><span v-if="project.created_at">注册于 {{ formatTime(project.created_at) }}</span><span>{{ project.root ? '本地工作目录' : '目录受服务端保护' }}</span></div></article></div>
    <div class="card preference-card"><div class="preference-symbol"><AppIcon name="eye" :size="22" /></div><div><h2>默认保持清爽</h2><p>全局折叠执行过程。你也可以在单个 Ticket 的 Activity 中单独覆盖。</p></div><label class="switch-label"><input type="checkbox" :checked="expanded" :disabled="preferencesBusy" @change="emit('preference', ($event.target as HTMLInputElement).checked, '')" /><span class="switch" /><span class="sr-only">默认展开过程消息</span></label></div>
    <p v-if="expanded" class="preference-caption">当前为默认展开。仅影响显示，不删除或隐藏审计与执行证据。</p>
  </section>
</template>
