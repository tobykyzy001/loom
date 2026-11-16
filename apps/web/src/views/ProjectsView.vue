<script setup lang="ts">
import type { LoomNode, Project } from '../api/types'
import { formatTime } from '../lib/format'
import AppIcon from '../components/AppIcon.vue'
import EmptyState from '../components/EmptyState.vue'

defineProps<{ projects: Project[]; nodes: LoomNode[]; expanded: boolean; preferencesBusy?: boolean; bindingBusy?: boolean; notice?: string }>()
const emit = defineEmits<{ add: []; bind: [project: Project]; 'create-grant': []; preference: [expanded: boolean, sender: string] }>()
</script>

<template>
  <section class="page-view"><div class="page-title"><span class="eyebrow">YOUR WORK DIRECTORIES</span><h1>项目有位置，授权有范围。</h1><p>这里是受控的工作目录，不是通往整台机器的钥匙。</p></div>
    <p v-if="notice" class="inline-note" role="status"><AppIcon name="check" :size="16" /><span>{{ notice }}</span><button class="text-link" @click="emit('create-grant')">前往权限页<AppIcon name="arrow" :size="14" /></button></p>
    <div class="projects-toolbar"><span class="muted small">{{ projects.length }} 个已注册项目</span><button class="button primary" @click="emit('add')"><AppIcon name="plus" :size="16" />添加项目</button></div>
    <EmptyState v-if="!projects.length" class="card" icon="projects" title="从一个真实项目开始" description="输入你已有的目录，并选择最小访问范围。空空的工作空间，不需要用示例填满。"><button class="button primary" @click="emit('add')"><AppIcon name="plus" :size="16" />创建第一个项目</button></EmptyState>
    <div v-else class="project-grid"><article v-for="project in projects" :key="project.id" class="project-card card"><div class="project-card-top"><span class="project-folder"><AppIcon name="projects" :size="24" /></span><span class="status-badge" :class="project.mode === 'read_write' ? 'waiting' : project.mode === 'read_only' ? 'active' : 'neutral'">{{ project.mode === 'read_write' ? '受控读写' : project.mode === 'read_only' ? '只读项目' : `未知模式：${project.mode}` }}</span></div><h2>{{ project.name }}</h2><span class="mono project-id">{{ project.id }}</span><div class="project-scope"><AppIcon :name="project.mode === 'read_write' ? 'edit' : 'eye'" :size="17" /><p>{{ project.mode === 'read_write' ? '可以申请目录内的文件写入，仍需要独立 Grant。' : '只允许授权范围内的读取，不改变原文件。' }}</p></div><div class="project-binding-action"><p v-if="project.root && nodes.length" class="hint">请核对项目根目录，并明确选择节点；绑定后才能创建 Grant。</p><p v-else-if="!project.root" class="hint">服务端未返回项目根目录，无法建立精确绑定。请通过明确配置补齐，不要改选其他目录。</p><p v-else class="hint">尚无已注册节点。请先在设备页注册节点，再进行资源绑定。</p><button class="button secondary" :disabled="!project.root?.trim() || !nodes.length || bindingBusy" @click="emit('bind', project)"><AppIcon name="devices" :size="15" />绑定本地节点资源</button></div><div class="project-card-bottom"><span v-if="project.created_at">注册于 {{ formatTime(project.created_at) }}</span><span>{{ project.root ? '本地工作目录' : '目录受服务端保护' }}</span></div></article></div>
    <div class="card preference-card"><div class="preference-symbol"><AppIcon name="eye" :size="22" /></div><div><h2>默认保持清爽</h2><p>全局折叠执行过程。你也可以在单个 Ticket 的 Activity 中单独覆盖。</p></div><label class="switch-label"><input type="checkbox" :checked="expanded" :disabled="preferencesBusy" @change="emit('preference', ($event.target as HTMLInputElement).checked, '')" /><span class="switch" /><span class="sr-only">默认展开过程消息</span></label></div>
    <p v-if="expanded" class="preference-caption">当前为默认展开。仅影响显示，不删除或隐藏审计与执行证据。</p>
  </section>
</template>
