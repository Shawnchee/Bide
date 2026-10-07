# Design reference: jup.ag (style language only)

Scanned 2026-10-06 with the `design-scan` skill (Playwright, 6 pages: home, rewards, token, spot, stocks, perps;
desktop 1440, tablet 768, mobile 390). Raw output was kept outside the repo. This file records **facts about the
reference** so Bide can borrow its *style language*. Bide does not copy Jupiter's logo, name, mascot, illustrations or copy.

## Overall
Dark-first trading terminal. Very dense: 12-14 px is the working text size, headings rarely exceed 16 px inside the
app (the marketing-style `rewards` page goes to 48 px). Surfaces are near-black blue-greys with soft 1 px borders;
almost no shadows. One bright accent (lime) for the primary CTA and active tab; green / pink for up / down numbers.
Motion is CSS-only (Tailwind transitions), short and quiet.

## Typography
- Family: **Inter** (Google Fonts, `wght@300;400;500;600;700`, `display=swap`). A self-hosted `EuclidCircular`
  @font-face is declared but is not the working UI face.
- Numbers: Inter with tabular figures in tables / prices.

| Role (computed) | Size / line height | Weight | Letter spacing | Colour |
|---|---|---|---|---|
| App H1 / section title | 16 / 24 | 400-600 | normal | slate-200 `oklch(0.929 0.013 255.5)` ≈ `#e2e8f0` |
| Panel heading (h2/h3) | 14 / 20 | 500-600 | normal | slate-200 |
| Body / list | 14-16 / 20-24 | 400 | normal | slate-200 |
| Secondary / caption (p) | 12 / 16 | 400-500 | normal | slate-500 `oklch(0.565 0.041 257.4)` ≈ `#62748e` |
| Button | 12-14 / 16-20 | 500 | normal | slate-400 `oklch(0.704 0.04 257)` ≈ `#90a1b9` (inactive) |
| Marketing H1 (rewards) | 48 / 48 | 700 | -1.2 px | slate-200 |
| Marketing H3 (rewards) | 18 / 28 | 600 | -0.45 px | slate-200 |
| Swap amount input | ~30 px | 500 | normal | muted until typed |

## Colour (exact hex, usage count from computed styles)
| Hex | Role | Count |
|---|---|---|
| `#090d10` | page background | 104 |
| `#0c1217` | recessed background | 9 |
| `#151e28` | panel / card surface | 35 |
| `#19242e` | raised surface, icon buttons, pills | 98 |
| `#212a36` | 1 px borders | 11 |
| `#314158` | strong surface / hover (slate-700) | 24 |
| `#f1f5f9` / `#cad5e2` | primary text (slate-100/300) | 13 / 12 |
| `#90a1b9` | secondary text (slate-400) | 50 |
| `#67778e` | muted text | 148 |
| `#c7f284` | accent: primary CTA fill, active tab text, toggles | 18 |
| `#3ce3ab` / `#1fd59a` | positive / up numbers, success border | 97 / 10 |
| `#f23674` | negative / down numbers | 52 |
| `#f04438` | destructive | 25 |
| `#00bef0` | info highlight | 18 |

Primary CTA text on lime is near-black (`#090d10`-ish). Accent links render `oklch(0.907 0.145 126.6)` (lime).
`theme-color` meta: `#1C2936`.

## Shape and spacing
- Radius histogram: full pill (162), 4 px (80), 6 px (56), 12 px (32), 16 px (20). Outer swap card ≈ 24 px,
  inner sell/buy panels 16 px, token selectors and tabs are pills.
- Borders: 1 px `#212a36`; inner panels separated by fill change rather than border (sell panel filled, buy panel
  outlined).
- Shadows: effectively none (all computed shadows transparent).
- Header 56 px with search input (pill-ish, `#151e28`), a 32 px ticker strip below it.
- Main content column ~510-516 px max for the swap card; dashboards use a 3-column card grid.
- Gaps 8-16 px; panel padding 16 px; table rows ~36-72 px depending on two-line cells.

## Components
- **Buttons**: primary = lime fill, near-black text, 12-16 px radius, 48-56 px tall in the swap card; secondary =
  `#19242e` pill with slate-200 text; ghost = transparent, slate-400 text turning slate-200 on hover.
- **Tabs**: segmented, active tab gets a `#19242e`-ish pill and lime text; inactive slate-400.
- **Inputs**: amount inputs are borderless, large (~30 px), right-aligned asset pill selector; small inputs use
  `#151e28` fill, 1 px border, pill or 8 px radius.
- **Badges**: tiny (10-11 px) pills: "New" lime fill/near-black text, "Beta" `#314158` fill, change % in green/pink
  tinted pills.
- **Tables / lists**: header row 11-12 px slate-500, rows separated by hairlines or by spacing, numbers right
  aligned, two-line cells (primary 14 px slate-200, secondary 12 px slate-500).
- **Stat rows**: label left 12-13 px slate-400, value right slate-200, accent-coloured for notable values.

## Motion
Libraries: none (Tailwind CSS transitions). Interactive elements use `150ms cubic-bezier(0.4, 0, 0.2, 1)` on
colour/background/border/opacity/transform; some buttons `150ms cubic-bezier(0, 0, 0.2, 1)` on colour+transform.
No scroll-triggered animation.

## Responsive
At 390 px: left sidebar collapses to a hamburger, a bottom tab bar appears, swap card goes full width with 12 px
gutters, the ticker strip scrolls horizontally inside itself, side columns stack below.

## How Bide uses this (and where it deliberately differs)
- Borrowed: Inter, the blue-grey dark neutrals (`#090d10` page, panel / raised / border steps), 12-14 px working
  sizes, filled swap panels with large tabular amounts and a unit pill, segmented pill tabs, hairline tables,
  150 ms colour transitions, near-zero shadows.
- Different on purpose: Bide's accent is its own evergreen-mint (`#62e3b6` dark / `#0b7d5c` light), not the lime
  `#c7f284`; "up" numbers reuse that accent instead of a second green. No left sidebar, ticker strip or bottom tab bar
  (Bide has six routes; a top nav + mobile sheet is enough). A light theme is kept. No logos, mascot or copy reused.
