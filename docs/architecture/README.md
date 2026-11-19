# Architecture diagrams

This directory contains eight illustrative diagrams referenced by [architecture.md](../../architecture.md). They explain object relationships and responsibilities, not implementation completion or a universal processing order. Ticket creation, Grant approval, Assignment/Lease and delivery remain distinct; a diagram cannot replace the authoritative text and verification documents.

## Re-render intentionally

`render_diagrams.py` is the only maintained renderer. There is no one-click rewrite of `architecture.md`: an earlier exploratory reflow draft was deliberately removed because its line-count guard and overwrite behavior could discard concurrent edits.

Requirements:

- Python 3 with Pillow.
- One available CJK font in the explicit `FONT_CANDIDATES` list. On macOS the default is the installed Songti font; adjust the list for another platform rather than accepting missing-glyph output.

From the repository root, using the workspace Python returned by `load_workspace_dependencies` when it supplies Pillow:

```sh
<workspace-python> docs/architecture/render_diagrams.py
```

The command replaces these eight owned PNGs in place in one run; review their diff and at least one image after rendering. `08-task-lifecycle.png` is referenced in the main text alongside the other seven images. The memory diagram distinguishes explicit Memory saving from reviewed automatic candidates; its “Verified Skill” check applies only to Skill. The recovery diagram ends unresolved sensitive effects in reconciliation/Needs Person, never automatic public retry.
