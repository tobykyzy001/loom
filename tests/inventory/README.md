# Bounded physical hardware observation

This is resource-observation evidence for **one physical macOS**, not an invented Model Registry or a claim of image generation capability and not a test on a second physical machine.

## Verified current read-only probe

```sh
LOOM_ENABLE_LOCAL_HARDWARE_PROBE=1 cargo test -p loom-concierge inventory_probe_actual_macos_once -- --ignored --nocapture
```

The command uses the actual OS executable `/usr/sbin/system_profiler` with only the fixed `SPDisplaysDataType` argument, no shell and no installation, SSH, remote discovery, model/provider calls or model weight downloads. On the reference run it returned `1 test passed`, `issues: []` and `permission_granted: false`.

Observed at **2026-11-16T20:12:45.679693Z**:

| Resource | Actual observation | Source / scope |
| --- | --- | --- |
| `hardware.gpu.model` | `Apple M5 Max` | controller_probed / available / fresh / local_only |
| `hardware.gpu.vendor` | `apple` | same |
| `hardware.gpu.metal` | `metal_4` | same |
| `models` | null **unknown**, no inspection | unverified / unknown |

VRAM was not observed in that output, so the code does not invent a capacity. These are bounded facts for one observed machine, not persistent guarantees for other devices or future conditions. GPU/Metal does **not** imply a usable local model, a local image generator, an offered provider, or an allowed task. A genuine provider/model/resource and separate permission verification would be required before any such claim. No image or inference process was executed.

## Safety and reproducibility boundaries

- The opt-in environment gate is checked for each native probe. The normal workspace test skips this physical inspection (explicit ignore until opted in).
- Executable paths and inspector choices are fixed. `MacDisplaysProfiler` selects only graphics facts; `MacSystemProfiler` covers optional memory plus graphics observations. Enum arguments are never passed in from fixtures or user strings.
- Stop/read limits: process timeout 5 seconds, stdout 64 KiB, stderr 4 KiB, with bounded pipe completion handling. Oversize, exit/timeout/start errors and malformed data stay unknown/error rather than turning into fake missing hardware. No `unsafe` was introduced.
- Reports retain only selected resource names/values, fact origin/confidence, timestamps and stable issue codes. Raw process output and stderr are not exposed publicly. Device serial, UUID, username, file paths, bus addresses, display resolutions and other identifiers are not stored.
- Refused or unsupported inspection is distinct from genuine absence or pending/detection errors. `permission_granted` remains false; no GPU/Model/folder authority is created.
- Synthetic process tests label results `fixture_synthetic`, never `controller_probed`. Executable fixtures must be explicit owner-writable-only regular non-symlink test files. Tests cover missing executable, timeout, nonzero status, oversized stdout/stderr, secret-looking data, argument validation, parsing, memory separation, metal/no-metal and unknown parse. They do not pretend that portable fixtures prove any actual machine's GPU or platform support.

Full Rust workspace tests and strict clippy passed after this change, alongside the maintained actual source-bound Agent/doc regressions. Linux, Windows, second-machine inventory, model installation/lifecycle and natural-language or image generation remain **NOT RUN** here. This change only makes the existing `loom.inventory.v1` observation more truthful and operationally bounded on macOS.
