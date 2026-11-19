# UI kit

Every screen builds from these parts. A new surface extends the nearest one instead of copying its classes. `pnpm check:ui-kit` (first step of `pnpm lint`, and in CI) fails on a hand-rolled copy and names the part to use. Copies that predate it are counted per file in `scripts/ui-kit.json`; counts only go down, so after removing one run `node scripts/check-ui-kit.mjs --lower`.

## Motion

| Part | File | When |
|---|---|---|
| `--motion-fast` 110ms, `--motion-moderate` 150ms, `--motion-large` 240ms; `--ease-standard`, `--ease-exit` | src/motion.css | Every CSS duration and curve. Reduced motion zeroes them here. |
| `MOTION_FAST_MS`, `MOTION_MODERATE_MS`, `MOTION_LARGE_MS`, `EASE_STANDARD`, `EASE_EXIT` | src/lib/motion.ts | The same values for `element.animate()` and inline styles. |
| `SWIPE_MOTION_MS`, `SWIPE_SPRING` | src/lib/phone-swipe.ts | Settling after a swipe or drag. |
| `animate-pop-in`, `animate-fade-in`, `animate-tip-in` | src/motion.css | A floating card, a fade, a tooltip. |

Lint `motion`: a raw time or curve in CSS, a class (`duration-200`, `ease-out`, `animate-[...]`), an inline style or `animate()` options. Plain `linear` (timers), endless loops and the reduced-motion `.01ms` pass.

## Back

| Part | File | When |
|---|---|---|
| `<BackButton label ariaLabel onClick>` | src/components/BackButton.tsx | "‹ Name" at the top left of a pushed page; the label names the page it goes back to. |

Lint `back`: a button with a left chevron or arrow (icon or ‹ text) that is not a prev/next pager.

## Pages and panels

| Part | File | When |
|---|---|---|
| `data-side-panel` with `max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in`; `usePresence` and `data-closing` to close | src/motion.css, src/lib/use-presence.ts | Page push and pop: side panels and a page opened over a list (SettingsPanel, InspectorPanel, Forum post). |
| `useSettingsSwipe` | src/lib/use-settings-swipe.ts | Swipe back from a pushed page on a phone. |
| `animate-fade-in` backdrop, `animate-pop-in` card, `usePresence` to close | src/lib/use-presence.ts | Sheets and floating cards (CreateBotSheet). |
| `Fold` | src/components/Fold.tsx | Expand and collapse in place. |

## Dialogs

| Part | File | When |
|---|---|---|
| `ConfirmDialog` | src/components/ConfirmDialog.tsx | Every confirm or destructive step: backdrop and Escape cancel, focus starts on Cancel. |

## Menus

| Part | File | When |
|---|---|---|
| `MENU_CLASS`, `menuKeyDown`, `holdToOpen` | src/components/MessageMenu.tsx | Every popup, dropdown and right-click menu: one menu look and keyboard (#1451). |
| `MENU_ITEM_HOVER` | src/lib/menu-style.ts | Each row in a menu. |
| `MediaMenu`, `FileMenu` | src/components/MediaMenu.tsx | The menu on a file or picture. |
| `useListMenuDismiss` | src/lib/use-hold-menu.ts | Closing a list's menu on scroll or an outside tap. |

Lint `menu`: `role="menu"`, a positioned `role="listbox"` or the menu look (`bg-card rounded-xl shadow-2xl shadow-black/60`) without `MENU_CLASS`; a `menuitem` without `MENU_ITEM_HOVER`.

## Buttons

| Part | File | When |
|---|---|---|
| `PRIMARY_BUTTON` | src/lib/button-style.ts | The filled accent action (Save, Send, Connect); add size and shape around it. |
| `ROW_BUTTON` | src/components/SettingsPrimitives.tsx | A small bordered action inside a settings or details row. |

Lint `button`: a button with `bg-accent` and `text-accent-ink` but not `PRIMARY_BUTTON`.

## Hover and press

- Menu rows `MENU_ITEM_HOVER`; list rows `hover:bg-raised/50`; primary `hover:brightness-110`; danger `hover:bg-danger/10`.
- Icon buttons `text-ink-secondary hover:text-ink`, with `hover:bg-raised` on a panel and `hover:bg-control` on a card.
- Press and fade come from one base rule in `src/motion.css`: every button dips to `scale: 0.97` while pressed, and every hover fades on `--motion-fast` with `--ease-standard`. Reduced motion makes both instant.
- Don't give a button its own `transition-*` or `active:` class, and make anything clickable a `<button>`; `pnpm check:ui-kit` fails both.

Lint `row`: a full-width, left-aligned row (`w-full text-left`) with a `hover:bg-raised/*` other than `/50`.

## Tooltips

| Part | File | When |
|---|---|---|
| `title` attribute | src/lib/tooltips.ts (`mountGlobalTooltips`) | Every hover hint; the global tip draws it. `PLAIN_TOOLTIP_CLASS` only for a tip it cannot show. |

## Focus ring

| Part | File | When |
|---|---|---|
| Global `:focus-visible` outline | src/styles.css | Every control. Never add a `focus-visible:ring-*` or remove the outline. |

## List rows

| Part | File | When |
|---|---|---|
| `sidebarConversationRowTone` | src/lib/sidebar-row.ts | A row in a list of chats or people. |
| `DETAILS_BOX`, `DETAILS_ROW` | src/components/BotDetailsRows.tsx | Grouped rows in a details or settings panel. |

## Chips

| Part | File | When |
|---|---|---|
| `ChatOptionChips` | src/components/ChatOptionChips.tsx | Reply choices under a message. |
| `ReactionChips` | src/components/Reactions.tsx | Reactions on a message. |
| `RoomToolChip` | src/components/GroupView.tsx | A tool in a room header. |
| `WorkerChip` | src/components/WorkerRows.tsx | A worker's status. |

A new chip starts from the nearest one by job.

## Settings row

Label left, control right, one row height.

| Part | File | When |
|---|---|---|
| `SwitchRow` (`DetailsSwitch` alone) | src/components/BotDetailsRows.tsx | On or off. |
| `SegmentedRow` (`Segmented` alone) | src/components/Segmented.tsx | 2 or 3 choices. |
| `AccountPicker` with `field` | src/components/UsageAccounts.tsx | A longer list. |

Lint `switch`: `role="switch"` outside BotDetailsRows.tsx. Lint `segmented`: a radiogroup or tablist drawn as a pill track (`bg-inset` or `bg-raised`, `p-1` or `p-[3px]`, rounded) outside Segmented.tsx.
