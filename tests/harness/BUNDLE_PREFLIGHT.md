# DSH bundle source preflight

This is a deterministic, **non-installing** inspection of the `@loom/dsh-loom@0.0.0` source. It reports file/package facts, safe initial configuration, and an export-shape probe on a temporary copy. It is not a remote installation, profile mutation, Host activation, agent/model test, trust decision, or distribution approval.

## Run

From the repository root:

```sh
node tests/harness/bundle-preflight.mjs
```

Expected outcome on this increment: exit `0`, **31 passed / 0 failed**. Tests create and remove only test-owned directories beneath the operating system temporary directory. They do not read or change the user DSH profile, credential store, global packages, or unknown parent directories. No network or model provider is contacted. The original source is read from the explicit repository-relative fixture path; every `node --check` and dynamic import runs against the separate isolated copy.

The executable helper is [bundle-preflight-lib.mjs](bundle-preflight-lib.mjs). The self-test includes assertions on the XML/text/icon bytes and negative fixture rejection. [preflight-schema-stub.mjs](fixtures/preflight-schema-stub.mjs) is only a tiny structural schema brought into a declared test-owned dependency location. It is not a Host implementation or verification of Schemastery compatibility. `apply(ctx, config)` is never invoked; no mock Host service or configuration is activated.

## Real package inventory (run **with cwd** `plugins/dsh-loom`)

The working directory itself is the target package; no `--prefix` positional alias or remote discovery is used. Do not confuse the workdir with an installer target/profile root.

```sh
npm pack --dry-run --ignore-scripts --json
```

Observed after the documentation metadata corrections: `entryCount: 23`, `unpackedSize: 104432`, `size: 30315`, `bundled: []`. The JSON contains `README.md`, `cordis.patch.yml`, `index.js`, `icon.svg`, `package.json`, `locale/en.json`, `locale/zh.json`, seven `lib/*.js`, and nine `src/*.js` files. The helper's included-file inventory independently counted **23 files and 104432 bytes**. `--dry-run` reports a hypothetical `loom-dsh-loom-0.0.0.tgz`; no tarball was created by this invocation. No installation, bundle registration, scripts, dependency resolution, upload, or publish was performed.

For a linked local source, the manifest `files` array does not itself filter a directory install. The file walker therefore emits each actual included file with a relative path, size and SHA-256. No source bodies, raw paths, credentials or process stderr are dumped into the report.

## What the v1 report means

Each deep-frozen report has:

- `schema: "loom.bundle-preflight.v1"`, `generated_at`, exact `manifest_id`, sorted `export_ids`, and bounded `checks`.
- `provenance.kind: "synthetic fixture source declared"`. The root is caller-supplied and not a verified install path. This declaration is not trust, auth, installation or signature.
- Files `{path, size, sha256}`. A byte change, including a README change, gives a new file hash; a status change is not required to detect it.
- `outcome: "static_pass_runtime_not_run"` when the checked source and optional inventory pass but actual activation remains deliberately `not_run`, and `"fail"` for invalid structure. There is no "all runtime/activation passed" outcome.
- Observed default separation **`enabled:false`, `allow_workers:false`, `executor:"unsupported"`**. `CAPABILITIES` and protocol fields do not become Grants.
- `activation.apply_invoked:false`, `registration_performed:false`, `configuration_mutated:false`. Import-only validation does not imply UI, registration, scheduling, task execution or permission.

`inspectBundle({rawRoot,...})` returns an inspection structure, not a versioned report. `runBundlePreflight({rawRoot,...})` runs the copy-based checks and returns a versioned frozen report. `rawRoot` is an absolute path to the exact plugin root, not its repository parent. `/`, HOME, a wrapper or missing patch/entrypoint is rejected. `private:true` is not a trust grant. Optional `dependencyRoot` must be an explicitly stated test-only dependency root and is copied to package-local `node_modules`; no package manager fills a missing dependency.

On the real checkout, `plugins/dsh-loom/node_modules/@deepseek-ai/schemastery` and top-level `node_modules/@deepseek-ai/schemastery` were absent. Consequently the source byte/structure checks pass but dependency resolution and actual `apply` execution are **NOT RUN** on that source. An explicitly supplied synthetic schema then observes `typeof apply === "function"`, arity 2, `Config` schema shape, and the actual `inject = ["agents", "sessionPersistence", "tools", "llm"]`. Those controlled-copy facts still do not prove real DSH dependency resolution, injection, model calls or actual Host activation.

## Bounds and rejection rules

- `package.json` and fixed patch: at most 64 KiB each; individual locale/README/detail: 1 MiB; icon: 256 KiB; JavaScript payload file: 256 KiB; inventory: at most 512 files / 8 MiB in total (the existing ~30 KiB source is well below it).
- Strict UTF-8 text, duplicate-object-key JSON detection, exact package name and version, ESM, local `./` export values, and patch exactly `./cordis.patch.yml`. No export fallback, filename rename or version auto-bump.
- A narrow YAML subset parses only the fixed `insert:[{id,name,config}]` rows. Duplicate/unknown ids or keys, unsupported tags/expressions and malformed `name::` fail before import. The shipped `enabled:true`, `allow_workers:true`, or a selected executor are not accepted as package defaults. Existing `false/false/unsupported` remain unchanged.
- `files` entries may be bare package-relative paths (as in the actual manifest) or `./relative`; exports require `./`. Every path rejects absolute paths, URLs, backslashes, traversal, symlinks, multi-link regular-file inodes and non-regular files. A symlink or an otherwise ordinary-looking hardlink cannot smuggle an external file into the trusted input. A separate hard-link escape test rejects the package before import. Source-relative `../src/` imports are normalized and checked against the root; no parent search is allowed. The secret-file name check rejects suspicious payloads before reading their contents.
- English `locale/en.json` and supplied Chinese `locale/zh.json` must contain non-template `meta.title` and `meta.description`. `meta.detail` is optional; if supplied it must be a bounded existing package Markdown document, never an absolute URL/path or traversal and never silently fall back to README. Host fallback rules are not reimplemented as authority.
- Icon signature matches its extension; SVG must be a text `svg` root with no HTML/script/`foreignObject` or event-handler attribute. File signatures are not visual rendering or malware certification.
- Child modules are only `process.execPath --check index.js`, or a bounded serialized import probe, with 15 s timeout and capped output (32 KiB stdout, 8 KiB stderr). Errors report bounded codes/exit numbers, never raw stderr/path/secret content. If Schemastery is missing, import is explicitly `not_run` rather than claiming an installed dependency exists.

Optional local pack checking (`pack:true`) uses `pack --dry-run --json --ignore-scripts --offline` in the temporary copy with a fixed 15 s child timeout. An unavailable npm is `not_run`; any nonzero exit remains a failure. A synthetic `process.exitCode=501` is observed as POSIX `245 (501 & 0xff)`, not rewritten or hidden. The self-test's small `pack:false` default does not require npm; its separate test stub exercises valid inventory and `ENOENT` handling. Real npm evidence is documented separately above; stub success is never real packaging or registration.

## Findings and exclusions

The current manifest/export list, locale title/description, icon bytes, patch id `loom-local-node`, and safe default configuration were already present and consistent; **no plugin files needed changes** in this task. No extra locale variant or version bump was invented. The helper found no genuine packaging mismatch: `files` maps to the exact 23-file payload, and no test code was included. Source does contain an explicitly opt-in dynamic import of `@loom/dsh-fixture-stub-provider/delegation`; it is a test-only alternate fixture surface (`delegation_tools` remains `unsupported`), not activated or counted as an enabled runtime dependency. Its default-off path is not imported by the probe.

This work does **not** assert a complete M6 milestone, installer readiness, app.asar legacy deployment correctness, npm publishing eligibility, HTTPS/auth signing, registry approval, remote deployment, DSH restart, UI rendering, real model/provider support, or real Host activation. Those remain unverified here.
