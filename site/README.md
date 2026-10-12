# Workbench website

Static site for the Workbench Claude Code mod. Plain HTML and CSS, no build step.

While Workbench Web runs it serves this folder at http://localhost:4477/docs/. On its own:

    cd site && python3 -m http.server 8000

| Page | What it covers |
| --- | --- |
| `index.html` | What Workbench is, in brief: how it works, what's in it, how to try it. |
| `architecture.html` | How it works inside: a feature's lifecycle (stages, the hooks at each one, what Laya asks, the observer), the module layout, the observer, the hooks, and turning on Laya. |
| `mods.html` | What Claude Code mods are, for readers new to them. |
| `hooks.html`, `laya.html` | Redirects to sections of `architecture.html`, so old links keep working. |

Facts come from the mod (`workbench/README.md`, `ARCHITECTURE.md`, `plugin.json`, v0.6.0) and from
Workbench Web (`workbench-web/README.md`, `decisions/`). When a hook, a runner or a decision point
changes, update the lifecycle diagram and the hooks table on `architecture.html`, and the version on
both main pages.

Every page links `styles.css?v=...`. Bump that value on every page whenever `styles.css` changes, so
browsers fetch the new file instead of a cached one.

Deploy the `site/` folder to any static host (GitHub Pages, Netlify, Cloudflare Pages).
