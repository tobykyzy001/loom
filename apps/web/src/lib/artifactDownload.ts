const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024

export interface ArtifactByteFile {
  bytes: Uint8Array
  filename: string
  mediaType: string
  sha256: string
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Independently verify the bytes, rather than trusting a claimed hash or name. */
export async function verifyArtifactBytes(content: string, metadata: {
  name?: string
  media_type?: string
  sha256?: string
  size_bytes?: number
  artifact_id: string
}, truncated: boolean | undefined): Promise<ArtifactByteFile> {
  const expectedSize = metadata.size_bytes
  const expectedSha = metadata.sha256?.toLowerCase()
  if (truncated !== false || !expectedSha || !/^[0-9a-f]{64}$/.test(expectedSha)
    || !Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0 || (expectedSize as number) > MAX_INLINE_ARTIFACT_BYTES) {
    throw new Error('缺少可接受下载的完整字节长度或 SHA-256；不会交付未核验的文件。')
  }
  const size = expectedSize as number
  if (content.length !== 4 * Math.ceil(size / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('原始字节返回的 base64 长度或规范编码不匹配；未生成下载文件。')
  }
  // A permissive atob ignores nonzero unused bits in the final quartet.
  // They must be zero for this explicitly canonical wire representation,
  // even when hashing the decoded bytes would produce the same SHA-256.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const nonCanonicalTail = (size % 3 === 1 && (alphabet.indexOf(content.at(-3) ?? '') & 0b1111) !== 0)
    || (size % 3 === 2 && (alphabet.indexOf(content.at(-2) ?? '') & 0b11) !== 0)
  if (nonCanonicalTail) throw new Error('原始字节返回的 base64 末位包含非规范填充比特；未生成下载文件。')
  const parts: Uint8Array[] = []
  for (let index = 0; index < content.length; index += 0x8000) {
    const decoded = atob(content.slice(index, index + 0x8000))
    const bytes = new Uint8Array(decoded.length)
    for (let offset = 0; offset < decoded.length; offset++) bytes[offset] = decoded.charCodeAt(offset)
    parts.push(bytes)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  const subtle = globalThis.crypto?.subtle
  if (typeof subtle?.digest !== 'function') throw new Error('此浏览器没有 Web Crypto SHA-256，不能安全核验原始字节，未生成下载文件。')
  const sha256 = hex(await subtle.digest('SHA-256', bytes))
  if (bytes.length !== size || sha256 !== expectedSha) {
    throw new Error('原始字节的长度或 SHA-256 与当前 Artifact 不匹配；未生成下载文件。')
  }
  let filename = typeof metadata.name === 'string'
    ? [...metadata.name.normalize('NFC').replace(/[<>:"|?*\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '')]
      .join('').trim().replace(/\.+$/, '')
    : ''
  // Bound UTF-8 bytes as well as user input character safety. Never cut
  // through a multi-byte code point to satisfy a filename limit.
  const encoder = new TextEncoder()
  if (encoder.encode(filename).length > 240) {
    let trimmed = ''
    let encodedBytes = 0
    for (const character of filename) {
      const width = encoder.encode(character).length
      if (encodedBytes + width > 240) break
      trimmed += character
      encodedBytes += width
    }
    filename = trimmed
  }
  if (!filename || filename === '.' || filename === '..') filename = `artifact-${metadata.artifact_id.replace(/[<>:"|?*\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '')}.bin`
  const mediaType = typeof metadata.media_type === 'string'
    && /^(?:[a-zA-Z0-9!#$&^_.+-]+)\/(?:[a-zA-Z0-9!#$&^_.+-]+)$/.test(metadata.media_type)
    ? metadata.media_type : 'application/octet-stream'
  return { bytes, filename, mediaType, sha256 }
}

/** Only an already user-authorized, hash-verified file reaches a download anchor. */
export function handOffArtifactDownload(file: ArtifactByteFile): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('当前浏览器不能建立受限下载，不将原始字节显示或执行为文档。')
  }
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mediaType }))
  try {
    if (!url.startsWith('blob:')) throw new Error('下载引用不属于此浏览器的临时对象 URL。')
    anchor.href = url
    anchor.download = file.filename
    anchor.style.display = 'none'
    anchor.rel = 'noopener noreferrer'
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }
}
