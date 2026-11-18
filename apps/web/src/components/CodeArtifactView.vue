<script setup lang="ts">
import { computed } from 'vue'
import type { ArtifactContent, Ticket } from '../api/types'
import { codeArtifactPresentation } from '../lib/codeEvidence'

const props = defineProps<{ ticket: Ticket; artifact: ArtifactContent; artifacts?: ArtifactContent[] }>()
const view = computed(() => codeArtifactPresentation(props.ticket, props.artifact, props.artifacts))
</script>

<template>
  <section class="code-artifact" aria-label="已下载产物内容；结构关联不替代中心权威校验">
    <header class="artifact-heading">
      <div><span class="label">已下载内容</span><code class="artifact-name">{{ view.name ?? '未命名 Artifact' }}</code></div>
      <span v-if="view.kind === 'change'" class="label">源码 Diff · 固定 fixture</span>
      <span v-else-if="view.kind === 'verification'" class="label">固定 node:test 验证</span>
      <span v-else class="label">原始文本</span>
    </header>
    <p v-if="view.kind === 'unsupported' && view.reason === 'incomplete_relation'" class="incomplete" role="note">证据关联不完整；仅提供当前原始内容，未确认到对应Attempt或验证状态。</p>
    <p class="boundary">{{ view.kind === 'unsupported' ? '未识别为关联代码证据；仅展示当前内容。' : '仅结构化关联已下载的授权内容；权威校验中心仍为最终依据，此处不独立验证 Artifact 字节摘要。' }}</p>

    <template v-if="view.kind === 'change'">
      <dl class="facts" aria-label="Source change and association">
        <div><dt>路径</dt><dd><code>{{ view.path }}</code></dd></div>
        <div><dt>Attempt</dt><dd>{{ view.relation.attempt }}</dd></div>
        <div><dt>Assignment / Effect</dt><dd><code>{{ view.relation.assignmentId }}</code><br><code>{{ view.relation.effectId }}</code></dd></div>
        <div><dt>Report</dt><dd>{{ view.relation.reportStatus }}</dd></div>
        <div><dt>Previous source SHA-256</dt><dd><code>{{ view.previousSha256 }}</code></dd></div>
        <div><dt>Current source SHA-256</dt><dd><code>{{ view.sha256 }}</code></dd></div>
        <div><dt>Verification Artifact</dt><dd><code>{{ view.relation.verificationArtifactId }}</code></dd></div>
        <div><dt>Session</dt><dd><code>{{ view.relation.sessionId }}</code></dd></div>
      </dl>
      <div class="code-diff" role="group" aria-label="Unified diff as literal text" aria-live="polite">
        <div v-for="(line, index) in view.lines" :key="index" :class="['code-diff-line', line.kind]"><span class="line-number" aria-hidden="true">{{ index + 1 }}</span><span>{{ line.text || ' ' }}</span></div>
      </div>
    </template>

    <template v-else-if="view.kind === 'verification'">
      <dl class="facts" aria-label="Verification result and association">
        <div><dt>Fixed command</dt><dd><code>{{ view.command }}</code></dd></div>
        <div><dt>Exit code / result</dt><dd><code>{{ view.exitCode }}</code> · <strong :class="view.passed ? 'passed' : 'failed'">{{ view.passed ? 'PASSED' : 'FAILED' }}</strong></dd></div>
        <div><dt>Previous test exit</dt><dd><code>{{ view.previousTestExitCode }}</code></dd></div>
        <div><dt>Attempt / Report</dt><dd>{{ view.relation.attempt }} · {{ view.relation.reportStatus }}</dd></div>
        <div><dt>Assignment / Effect</dt><dd><code>{{ view.relation.assignmentId }}</code><br><code>{{ view.relation.effectId }}</code></dd></div>
        <div><dt>Source / verification Artifact</dt><dd><code>{{ view.relation.sourceArtifactId }}</code><br><code>{{ view.artifactId }}</code></dd></div>
        <div><dt>Source path</dt><dd><code>{{ view.relation.path }}</code></dd></div>
        <div><dt>Previous source SHA-256</dt><dd><code>{{ view.relation.previousSha256 }}</code></dd></div>
        <div><dt>Current source SHA-256</dt><dd><code>{{ view.relation.sha256 }}</code></dd></div>
        <div><dt>Edit / verification Result</dt><dd><code>{{ view.relation.editResultId }}</code><br><code>{{ view.relation.verificationResultId }}</code></dd></div>
      </dl>
      <section class="code-verification-result test-output" :class="view.passed ? 'output-passed' : 'output-failed'" aria-label="Fixed node test result" :data-exit-code="view.exitCode" :data-report-status="view.relation.reportStatus" :data-assignment-id="view.relation.assignmentId" aria-live="polite">
        <h3>stdout <span class="label">bounded plain text</span></h3><pre>{{ view.stdout }}</pre>
        <h3>stderr <span class="label">bounded plain text</span></h3><pre>{{ view.stderr }}</pre>
      </section>
    </template>
    <details v-if="view.kind !== 'unsupported'" class="original-bytes"><summary>当前 Artifact 原文（未修改）</summary><pre class="artifact-content" aria-label="Original downloaded artifact bytes">{{ artifact.content }}</pre></details>
    <pre v-else class="artifact-content" aria-label="Original artifact text" aria-live="polite">{{ view.content }}</pre>
  </section>
</template>

<style scoped>
.code-artifact { color: #38423d; font-size: 12px; line-height: 1.65; }
.artifact-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.artifact-heading > div { min-width: 0; display: flex; flex-direction: column; }
.artifact-name, .facts code { overflow-wrap: anywhere; }
.label { color: #68716c; font-size: 11px; margin-left: 7px; }
.boundary { color: #68716c; margin: 10px 0; }
.incomplete { background: #f8e6ea; color: #915758; padding: 10px; border-radius: 6px; margin: 10px 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 13px 22px; margin: 18px 0; }
.facts > div { min-width: 0; }
.facts dt { color: #68716c; font-size: 11px; }
.facts dd { margin: 3px 0 0; }
.code-diff { font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; border: 1px solid #e1e5e2; border-radius: 6px; overflow-x: auto; }
.code-diff-line { display: flex; min-width: min-content; white-space: pre-wrap; overflow-wrap: anywhere; }
.code-diff-line.removed { background: #f8e6ea; color: #915758; }
.code-diff-line.added { background: #dceadf; color: #226742; }
.code-diff-line.heading { color: #596560; }
.line-number { user-select: none; flex: 0 0 32px; margin-right: 10px; text-align: right; color: #7b837e; }
.test-output { max-height: 260px; overflow: auto; border: 1px solid #e1e5e2; border-radius: 6px; padding: 12px; }
.test-output h3 { font-size: 11px; margin: 5px 0; }
.test-output pre, .artifact-content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.artifact-content { max-height: 260px; overflow: auto; }
.original-bytes { margin-top: 16px; }
.passed { color: #226742; }
.failed { color: #915758; }
</style>
