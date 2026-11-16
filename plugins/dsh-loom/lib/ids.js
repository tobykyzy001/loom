import { sha256 } from '../src/util.js'

/** Stable, content-derived protocol UUID; the same actual effect/artifact does not vary on replay. */
export function stableArtifactId(value) {
  const hex = sha256(value).slice(0, 32).split('')
  hex[12] = '4'; hex[16] = '89ab'[Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}
