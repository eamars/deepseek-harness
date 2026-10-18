# DSH settings sections — product integration reference

This directory is a **reference example**, not a DSH core change. It shows how a
product plugin registers its own pages in the DSH settings dialog through the
existing `settings.section` slot.

- `client.js` is the client half of `@soyo/dsh-dashboard` from the
  [Agent-for-qqbot](https://github.com/jixiong398-blip/Agent-for-qqbot) product.
- `setup-api.mjs` is the host-side `botSetup` remote service that backs the
  pages (fixed private supervisor API; no arbitrary URL/command).
- Pages registered after `agent-presets` (`order: 20`):
  - `soyo-bot-models` (order 30, 模型与脑区)
  - `soyo-bot-persona` (order 31, 角色设定)
  - `soyo-bot-qq` (order 32, NapCat / QQ)
  - `soyo-dashboard` (order 34, 管理 Web — embedded service status,
    start/stop controls and per-service logs, with an optional link to the
    standalone management console)
- Registration shape:

  ```js
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id, order, label }, Page))
  ```

  `Page` receives `{ close }` and renders inside the settings content column;
  the shell owns modal visibility and navigation. The registrant re-registers
  with fresh text on locale change.
- The product's former sidebar-footer shortcuts were removed in favour of these
  pages; the owner session is opened from the normal session list, so it has no
  settings page of its own.

Scope: the copy and panels are product-specific (Bot / NapCat). This PR is
shared as an implementation reference; feel free to close it if it is not useful
for the fork.

Synced from Agent-for-qqbot 1.0.1 (`70452dd25a5e68d5dd50f6c89f200f89d4c3a4c1`);
`client.js` and `setup-api.mjs` are text-identical to that revision.
