// Structural import fixture only: no validator implementation, Host, context, network, or activation.
const base = { kind: 'schema', shape: undefined }
for (const method of ['step', 'min', 'max', 'description']) base[method] = () => base
base.default = (value) => {
  const schema = { kind: 'schema', defaultValue: value }
  for (const method of ['step', 'min', 'max', 'description']) schema[method] = () => schema
  schema.default = base.default
  return schema
}
const trap = (target, key) => target[key] || (() => base)
const z = new Proxy({ object: (shape) => ({ kind: 'object', shape }) }, { get: trap })
export default z
