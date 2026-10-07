# Brand — Bide

_Name your price. Get paid until it fills._ Consumer fintech on Solana for SOL holders and USDC savers.

**Direction (2026-10-06): "Night Ledger" — dark-first, data-dense trading-terminal style.** Replaces the earlier
light "Evergreen Ledger" (serif display on warm paper), which the user found too "vibe-coded". The *style language*
(type scale, neutrals, density, swap-card inputs, compact tables, quiet 150 ms motion) is referenced from jup.ag —
facts in `app/design-reference.md`. Bide keeps its own name, wordmark, accent colour and voice. We do **not** use
Jupiter's logo, name in UI chrome, mascot, lime accent, illustrations or copy. "Jupiter Lend" appears only where we
factually describe the integration (and in the landing comparison table).

## Palette (hex tokens in `app/app/globals.css`; dark is the default theme, light still works)

| Token | Dark | Light | Role |
|---|---|---|---|
| background | `#090d10` | `#f5f7f9` | page |
| card | `#10161d` | `#ffffff` | panels, cards |
| secondary / muted | `#19222c` / `#151d26` | `#edf1f5` | swap panels, pills, hovered rows |
| border / input | `#1f2833` / `#263140` | `#e1e7ee` / `#d5dde6` | 1 px hairlines |
| foreground | `#e6ebf1` | `#0f1720` | text |
| muted-foreground | `#90a1b9` | `#4f5d70` | secondary text (≥ 7:1 dark, ≥ 6:1 light) |
| **primary** (the one accent) | `#62e3b6` evergreen-mint | `#0b7d5c` evergreen | primary CTA, active nav/tab text, "earned", focus ring |
| primary-foreground | `#06120d` | `#ffffff` | text on the CTA |
| accent / accent-foreground | `#10261f` / `#8cedc9` | `#e3f4ee` / `#075c44` | selected choice, "filled" states, soft buttons |
| positive | = primary | = primary | money in / up numbers |
| destructive | `#f2557f` | `#d42a5b` | rejections, losses, errors |
| warning / -soft / -foreground | `#f0b43c` / `#241c0c` / `#f5d48c` | `#d99a1e` / `#fdf3dc` / `#6b4a07` | devnet badge, "checked once" notice, offline banner |

Single accent + blue-grey neutrals. No pure black, no shadows on cards (separation by fill and 1 px borders).

## Typography
- **Inter** (`next/font/google`, `--font-inter`) for everything, with `cv11`/`ss01` on. Headlines are Inter 600 with
  tight tracking (`.font-display`: −0.022 em). No serif.
- Scale: page H1 24–28 px; landing hero 40–64 px; section/card titles 14–15 px semibold; body 13–14 px; captions and
  table headers 12 px muted; badges 11 px.
- Numbers: Inter tabular figures (`.num`). Addresses, hashes, tool names: **JetBrains Mono** (`font-mono`, 11–12 px).

## Components
- **Buttons**: primary = mint fill, near-black text, `rounded-xl`, 44–48 px for page CTAs (full width inside panels);
  `soft` = accent tint (Connect wallet, assistant actions); `secondary` = filled pill; `ghost` for tertiary.
- **Swap-card inputs** (`.swap-panel`, `.swap-input`, `.swap-pill`): filled `rounded-2xl` panel, 12 px label top-left,
  28 px borderless tabular amount, unit pill on the right. Used on /earn (price, amount), the review commit card,
  /pool and the landing live card.
- **Choices**: 1 px bordered tiles on a faint fill; selected = mint border + accent fill.
- **Segmented tabs**: pill container, active item `bg-secondary` + mint text (desk filters, pool deposit/withdraw, nav).
- **Tables** (`.data-table`): 12 px muted header, hairline rows, hover tint, right-aligned tabular numbers.
- **Stat grids**: `gap-px` grid on the border colour, 12 px label, 18–20 px semibold value.
- Radius: `--radius` 0.5 rem → inputs 8 px, panels 14–18 px, pills full.

## Motion
150 ms `cubic-bezier(0.4, 0, 0.2, 1)` on colour/background/border; list items fade in (300 ms); no `transition-all`;
`prefers-reduced-motion` honoured globally.

## Voice (unchanged)
- Plain English. No "put", "call", "strike", "premium", Greeks or APY in the main flow — those live only in the
  "How it works under the hood" drawer (and the trader-facing /maker page).
- Always: "checked once at the end of the round — not the moment the price touches your level". Show the crash case.
- Never say "same as a limit order"; say "same price as a limit order, different trigger".
- Every money figure the user receives is shown **after** Bide's fee, and says so.
- Honest status: devnet, unaudited, worker offline → say it.
