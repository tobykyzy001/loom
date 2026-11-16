import { generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertObject, id, readJson, sha256, writeJsonAtomic } from './util.js'

/** Creates a node-specific identity; private key stays in the isolated state directory. */
export class NodeIdentity {
  static async open(stateDir) {
    const file = join(stateDir, 'identity.json')
    let data = await readJson(file)
    if (!data) {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const public_key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
      data = { version: 1, node_id: sha256(Buffer.from(public_key, 'base64url')), installation_id: id(), public_key,
        private_key_pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url') }
      await writeJsonAtomic(file, data)
    }
    if (data.version !== 1 || !/^[a-f0-9]{64}$/.test(data.node_id) || data.node_id !== sha256(Buffer.from(data.public_key, 'base64url'))) {
      throw new Error('Persistent node identity is invalid')
    }
    const privateKey = Buffer.from(data.private_key_pkcs8, 'base64url')
    if (privateKey.length !== 48) throw new Error('Persistent node private key is invalid')
    return new NodeIdentity(file, data)
  }
  constructor(file, data) {
    this.file = file
    // Never let { ...identity } or JSON.stringify(identity) serialize a private key/node token.
    Object.defineProperty(this, 'data', { value: data, enumerable: false, writable: false })
    this.node_id = data.node_id; this.installation_id = data.installation_id
  }
  get nodeId() { return this.data.node_id }
  get installationId() { return this.data.installation_id
  }
  get public() { return { protocol: 'loom.node.v1', node_id: this.data.node_id, installation_id: this.data.installation_id,
    public_key: this.data.public_key } }
  get public_key() { return this.data.public_key }
  get token() { return this.data.token || '' }
  async setToken(token) {
    assertObject(token, 'token')
    this.data.token = token.token || token.access_token || token.node_token
    if (typeof this.data.token !== 'string' || !this.data.token) throw new Error('Registration response has no node token')
    this.data.enrolled_at = new Date().toISOString()
    await writeJsonAtomic(this.file, this.data)
  }
  get token() { return this.data.token || '' }
  sign(nonce) {
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('Challenge nonce must be 64 lowercase hex characters')
    return sign(null, Buffer.from(nonce, 'utf8'), { key: Buffer.from(this.data.private_key_pkcs8, 'base64url'), format: 'der', type: 'pkcs8' }).toString('base64url')
  }
}
