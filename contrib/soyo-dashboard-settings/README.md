# DSH settings sections — product integration reference

This directory is a **reference example**, not a DSH core change. It shows how a
product plugin registers its own pages in the DSH settings dialog through the
existing `settings.section` slot.

- `client.js` is the client half of `@soyo/dsh-dashboard` from the
  [Agent-for-qqbot](https://github.com/jixiong398-blip/Agent-for-qqbot) product.
- It registers settings pages after `agent-presets` (`order: 20`):
  - `soyo-bot-models` (order 30, 模型与脑区)
  - `soyo-bot-persona` (order 31, 角色设定)
  - `soyo-bot-qq` (order 32, NapCat / QQ)
  - `soyo-dashboard` (order 34, 管理 Web)
- Registration shape:

  ```js
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id, order, label }, Page))
  ```

  `Page` receives `{ close }` and renders inside the settings content column;
  the shell owns modal visibility and navigation. The registrant re-registers
  with fresh text on locale change.
- The product's former sidebar-footer shortcuts were removed in favour of these
  pages.

Scope: the copy and panels are product-specific (Bot / NapCat). This PR is
shared as an implementation reference; feel free to close it if it is not useful
for the fork.
