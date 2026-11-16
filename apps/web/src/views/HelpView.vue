<script setup lang="ts">
import AppIcon, { type IconName } from '../components/AppIcon.vue'

const emit = defineEmits<{ connect: [] }>()
const topics: { icon: IconName; title: string; text: string }[] = [
  { icon: 'conversation', title: '从一个小目标开始', text: '在对话页面选择真实项目，描述目标。读取摘要不会修改原文件；写入文件只接受项目内的相对路径与文本。' },
  { icon: 'shield', title: '如何知道任务完成了？', text: '只有结构化成功报告能显示已完成。等待批准、失败、取消与待对账各有不同含义，未知结果不会被当成成功。' },
  { icon: 'access', title: '设备、项目与授权', text: '设备注册和能够连接不代表被授权。项目的读取与操作需要明确 Grant；执行时还需要独立的短期 Lease。' },
]
</script>

<template>
  <section class="page-view help-view"><div class="help-hero"><span class="help-orb"><AppIcon name="help" :size="30" /></span><span class="eyebrow">A LITTLE GUIDANCE</span><h1>把复杂留给我们，<br />把决定留给你。</h1><p>Loom 是你的工作入口，而不是一个替你做所有决定的黑盒。这里介绍 M0 的关键边界。</p></div><div class="help-topics"><article v-for="topic in topics" :key="topic.title" class="card"><span class="help-topic-icon"><AppIcon :name="topic.icon" :size="22" /></span><h2>{{ topic.title }}</h2><p>{{ topic.text }}</p></article></div><div class="faq-list card"><details open><summary>没有项目时，我应该怎么做？<AppIcon name="chevron" :size="17" /></summary><p>从「项目」或输入框旁的加号创建一个真实项目。输入协调器所在机器上的已存在目录，默认选择只读。服务器会验证目录；前端不会获取或扫描你的真实文件系统。</p></details><details><summary>如何安全地连接？<AppIcon name="chevron" :size="17" /></summary><p>与你的协调器管理员取得 Client Token，在连接设置中手动输入。它保存在当前浏览器的 localStorage，请避免在不受信任的共享浏览器保存。</p><button class="button secondary" @click="emit('connect')">打开连接设置</button></details><details><summary>过程折叠后，记录会被删除吗？<AppIcon name="chevron" :size="17" /></summary><p>不会。折叠和发送者筛选只是显示偏好，不会改变 Ticket、Report、Artifact 或审计事实。看到过程不等于越过资源访问权限。</p></details><details><summary>手机离开后，任务会停止吗？<AppIcon name="chevron" :size="17" /></summary><p>手机是查看与审批的客户端，不是长期在线 Worker。桌面 Host 的任务不依赖手机浏览器保持打开；断网恢复后以协调器权威状态为准。</p></details></div><div class="help-footer"><AppIcon name="shield" :size="18" />开放、受控、诚实 —— Loom 的工作方式。<a href="https://github.com/deepseek-ai/dsh-superagent-prototype" target="_blank" rel="noopener noreferrer nofollow">了解设计参考<AppIcon name="external" :size="13" /></a></div></section>
</template>
