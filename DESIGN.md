---
name: dodgy
description: A Game Boy-era Pokédex reskin — chunky double-black-border dialogs, pixel type, and dex-shell chrome across the guardian popup, gate, and settings.
colors:
  poke-red: "#dc0a2d"
  poke-red-dark: "#a30a24"
  poke-red-dark-alt: "#a80822"
  danger: "#c0263a"
  spare-green: "#2e8b3d"
  lcd-green: "#9bbc0f"
  lcd-green-dark: "#0f380f"
  lcd-green-mid: "#306230"
  name-bar-bg: "#143d2b"
  name-bar-fg: "#b6f0c8"
  gb-paper: "#f7f7ef"
  gb-paper-edge: "#d9d9cc"
  gb-ink: "#17181f"
  gb-ink-dim: "#4a4d5c"
  gb-hint: "#6d707c"
  gb-bg-top: "#12131c"
  gb-bg-bot: "#05060a"
  bezel: "#dedede"
  bezel-dark: "#9a9a9a"
  outline: "#1b1b1b"
  coin: "#f4c430"
  heart: "#dc0a2d"
  heart-empty: "#7a7a7a"
typography:
  display:
    fontFamily: "'Press Start 2P', ui-monospace, 'Courier New', monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "1px"
  title:
    fontFamily: "'Press Start 2P', ui-monospace, 'Courier New', monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "1px"
  body:
    fontFamily: "'Press Start 2P', ui-monospace, 'Courier New', monospace"
    fontSize: "9px"
    fontWeight: 400
    lineHeight: 1.9
    letterSpacing: "0.5px"
  label:
    fontFamily: "'Press Start 2P', ui-monospace, 'Courier New', monospace"
    fontSize: "7px"
    fontWeight: 400
    lineHeight: 1.9
    letterSpacing: "0.02em"
rounded:
  none: "0px"
  chip: "2px"
  pill: "999px"
  bezel: "8px 8px 26px 8px"
spacing:
  xs: "0.3rem"
  sm: "0.6rem"
  md: "0.8rem"
  lg: "1.2rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.poke-red}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "11px 26px"
  button-continue:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.none}"
    padding: "0.8rem 1.1rem"
  button-spare:
    backgroundColor: "{colors.spare-green}"
    textColor: "#ffffff"
    rounded: "{rounded.none}"
    padding: "0.8rem 1.1rem"
  dialog:
    backgroundColor: "{colors.gb-paper}"
    textColor: "{colors.gb-ink}"
    rounded: "{rounded.none}"
    padding: "2rem 2rem 1.6rem"
---

# Design System: dodgy

## 1. Overview

**Creative North Star: "The Pokédex Shell"**

Every surface is a piece of Pokédex hardware you're looking through, not a webpage skinned to look like one. The popup is the red dex-shell itself — bezel, lens, D-pad, LCD screen. The gate and settings pages are the chunky white dialog boxes that would pop up *on* that hardware: double black borders, hard corners, Press Start 2P rendered at pixel sizes small enough that `-webkit-font-smoothing: none` and `image-rendering: pixelated` read as intentional, not broken. Nothing here simulates a modern app that happens to have a retro theme; the target is Gen 2/3 Pokédex UI and PMD SpriteCollab overworld sprites specifically; if a screen wouldn't plausibly render on that hardware, it doesn't belong.

The tone stays playful and retro first — collectible, a little silly, fond of its own creature — with the guilt mechanic's real emotional weight sitting underneath rather than announcing itself through the visual language. Low-HP and faint states get *more* urgent color and pacing, never a shift into a different (grimmer, flatter) design system. This system explicitly rejects generic mobile gacha/idle-game chrome (gradient buttons, coin-shower juice, F2P App Store polish) and flat modern SaaS (soft shadows, rounded cards, clean sans-serif) — both read as a different product wearing this one's skin.

**Key Characteristics:**
- Chunky and tactile: thick black borders, hard offset drop-shadows, buttons that visibly displace on press
- Two hardware registers only — red dex-shell chrome (popup) and white GB dialog box (gate, settings) — never invent a third
- Press Start 2P everywhere, at real pixel sizes (7–14px), never smoothed
- LCD green as the "screen within the screen" for flavor text, notes, and readouts
- Flat by default; the only depth cue is the hard offset shadow, never blur

## 2. Colors: The Dex-Shell Palette

Two families do all the work: Pokédex red for the hardware/brand and calls to attention, and LCD green for the readable "screen" surfaces nested inside dialogs. Everything else is near-black ink, off-white paper, and a narrow bezel-gray range.

### Primary
- **Poké Red** (`#dc0a2d`): the dex-shell's dominant color — popup shell gradient, primary buttons, countdown timers, hearts, type-badge accents. Carries the brand at a Committed level (30–60% of the popup surface).
- **Poké Red Dark** (`#a30a24` in gate.css / `#a80822` in settings.html): shade used for gradients, hover-darkening, and settings-page links on white. Treat the two hex values as the same role in different files; don't introduce a third.
- **Poké Red Heading** (`#bb0826`, settings.html only): a heading-only darkening of Poké Red, used exclusively where red text sits directly on the dimmed map background (settings `h1`, `h2`, and the blocklist `<summary>`). Poké Red itself is only 3.78:1 there and fails WCAG AA; this variant clears 4.92:1. Never use plain `--pokedex-red` for text against `--bezel`/the map veil — always route through this token instead.

### Secondary
- **LCD Green** (`#9bbc0f`) / **LCD Green Dark** (`#0f380f`): the nested "screen" pairing — sub-screens, notes, incubator captions, evolution text. Always paired together (green background, dark-green ink), never green text on paper or paper text on green.
- **Spare Green** (`#2e8b3d`): the one warm affirmative color, reserved for the "Spare it" button. Never reused elsewhere — its rarity is what makes it read as the kind choice.

### Neutral
- **GB Paper** (`#f7f7ef`) / **GB Paper Edge** (`#d9d9cc`): the dialog-box background across gate and settings' `--dialog`. Off-white, not pure white — keep it that way; pure white reads as flat-SaaS.
- **GB Ink** (`#17181f`): primary text on paper, borders, outline strokes. Near-black, not pure `#000` for text (pure black is reserved for structural borders).
- **GB Ink Dim** (`#4a4d5c`): secondary/supporting text on paper (7.78:1).
- **GB Hint** (`#6d707c`, corrected from `#7a7d8a`): the smallest hint/caption text on paper. The original value measured 3.80:1 against `--gb-paper` and failed WCAG AA body-text contrast; this is the corrected canonical value at 4.58:1. Always use the corrected token; the old value must not reappear.
- **GB Background** (`#12131c` → `#05060a` gradient): the dark backdrop behind the gate's full-screen chase and dialog scrims.
- **Bezel** (`#dedede`) / **Bezel Dark** (`#9a9a9a`): the popup's plastic bezel and the settings page's body background (dimmed map veil sits on top).

### Named Rules
**The Two-Register Rule.** Every surface is either red dex-shell chrome or a white GB dialog box. A screen that tries to be both, or introduces a third background family, breaks the hardware illusion.

**The Rarity Rule.** Spare Green appears in exactly one place: the spare/forgive action. Danger red variants are reserved for damage, faint, and destructive confirmation. Reusing either color for a neutral action dilutes the meaning both are built to carry.

## 3. Typography

**Display/Body/Label Font:** Press Start 2P (with `ui-monospace, 'Courier New', monospace` fallback) — the only typeface in the system, carrying every role through size alone.

**Character:** A single bitmap-style pixel font used at real small sizes (7–14px) rather than scaled up for legibility. `-webkit-font-smoothing: none` and no anti-aliasing assumption — the jagged pixel edge is the point, not a compromise.

### Hierarchy
- **Display** (400, 14px, 1.6 line-height, 1px letter-spacing): page-level headings only (`h1` on settings, `.gb-dialog h2` on gate). Rare — one per screen.
- **Title** (400, 10–11px, 1.4–1.6 line-height): section headings (`h2`), the popup title bar, party/starter names.
- **Body** (400, 8–9px, 1.8–1.9 line-height): dialog copy, field labels, form text. Cap prose at ~42ch (already enforced by `.gb-dialog p`).
- **Label** (400, 6–7px, letter-spacing 0.02–0.5em): captions, LCD readouts, type badges, footnotes — the smallest legible tier at this pixel size.

### Named Rules
**The One Typeface Rule.** Press Start 2P is the only font family anywhere in the system, including fallbacks used only for a pre-load flash. Introducing a second family (even a "cleaner" one for body copy) breaks the hardware illusion immediately.

**The No-Scale-Up Rule.** Never render Press Start 2P above ~14px. The font is designed for genuine pixel sizes; scaling it up for "readability" or "hero" moments produces blocky, ugly type rather than a bigger pixel-art heading. If a heading needs more visual weight, use color (Poké Red) or spacing, not size.

## 4. Elevation

Flat by default — no blurred shadows anywhere in the system. Depth is conveyed entirely through **hard, non-blurred offset shadows** (`box-shadow: Npx Npx 0 #000` or a color) that double as a "this is pressable" affordance, and through the double-border box-shadow trick that fakes a two-layer picture-frame border on dialogs.

### Shadow Vocabulary
- **Dialog frame** (`box-shadow: inset 0 0 0 4px var(--gb-paper), inset 0 0 0 8px #000, 0 0 0 4px var(--poke-red)`): the signature GB dialog double-border. Paper ring, black ring, red ring — in that order, outside-in.
- **Button rest** (`box-shadow: 3px 3px 0 #000`): default state for `.btn`, giving buttons a hard offset "card" edge.
- **Button pressed** (`box-shadow: 0 0 0 #000` + `transform: translate(3px, 3px)`): the shadow collapses to zero and the button moves into the space it occupied — no easing bounce, an instant mechanical press.
- **Card hover** (`box-shadow: 6px 6px 0 var(--poke-red)` + `transform: translate(-2px, -2px)`): starter cards and party rows lift up and away on hover/focus, shadow growing and recoloring to red.

### Named Rules
**The Hard-Shadow-Only Rule.** No `blur-radius` greater than 0 anywhere. Every shadow in this system is a flat offset, matching pixel-art rendering — a soft blurred shadow reads as a modern UI leaking through the pixel skin.

## 5. Components

Every interactive surface is chunky and tactile: thick black borders (2–4px), hard offset shadows that collapse on press, and zero smooth easing on interaction feedback — pressing a button should feel like a real button click, not a modern micro-interaction.

### Buttons
- **Shape:** square corners (`0` radius) for in-context actions (`.btn`, `.ab`); full pill (`999px`) reserved for the settings page's single primary Save action, marking it as the one "big" commitment button on that screen.
- **Primary (Continue/Danger):** `--danger` (#c0263a) background, white text, 3px black border, `3px 3px 0 #000` shadow.
- **Spare/Affirmative:** `--spare-green` background, same border/shadow treatment — differs from Continue only in color, reinforcing they're siblings in the same choice.
- **Hover / Focus:** hover darkens the fill slightly (no transform); `:focus-visible` gets a 3px Poké Red outline offset 3–4px — never rely on color change alone for focus.
- **Press:** shadow flattens to 0 and the button translates into the vacated shadow space, in ~0.08s with no ease-in — an instant mechanical click, not a spring.

### Cards (starter picks, party rows, egg cards)
- **Corner Style:** square by default; the egg shape is the one deliberate exception (organic border-radius, because it's literally an egg).
- **Background:** off-white paper (`#fffdf4`/`#f0f0f0`), never pure white.
- **Shadow Strategy:** hard offset per the Elevation section; grows and recolors to Poké Red on hover/focus/selected rather than gaining blur.
- **Border:** 2–3px solid black at rest; recolors to Poké Red when `aria-checked="true"` or `.selected`.
- **Internal Padding:** generous relative to the pixel type scale (0.7–1rem) so touch/click targets stay comfortable despite tiny text.

### Inputs / Fields (settings page)
- **Style:** 2px solid black border, off-white/`--dialog` background, square corners, no border-radius.
- **Focus:** 2px solid black outline, 2–3px offset — high-contrast rather than a soft glow, matching the hardware aesthetic.
- **Error:** border and box-shadow recolor to `--danger`; an inline `.error` message appears below in the same danger red, never color-only.
- **Range slider:** custom-styled to look like a physical toggle — chunky white track with black border, square Poké Red thumb. No native OS slider chrome should ever show through.

### Navigation (popup mode-strip, D-pad)
- Mode tabs render as small red-on-dark-red chips; the active tab swaps to LCD green background with dark-green text — the same "screen lit up" language used everywhere else for "this is the active/readable one."
- The D-pad and action buttons are literal Game Boy control chrome (physical button shapes, not a generic tab bar), reinforcing that the popup is hardware, not a webpage.

### Dialog Box (signature component)
The GB dialog (`.gb-dialog` / settings `section`) is the system's signature: paper background, the triple-ring double-border shadow trick, centered pixel type capped at readable widths (26–42ch), and a hard black 4px outer border. Every full-screen or modal-style surface in gate.ts and settings.html is built from this one shape — do not invent a second modal/dialog treatment.

## 6. Do's and Don'ts

### Do:
- **Do** keep every surface inside one of the two hardware registers: red dex-shell chrome or white GB dialog box.
- **Do** use hard, non-blurred offset shadows (`Npx Npx 0 <color>`) for all elevation and pressed-state feedback.
- **Do** render Press Start 2P at real pixel sizes (7–14px) with `image-rendering: pixelated` and no font smoothing.
- **Do** route settings-page heading red through `--pokedex-red-heading` (#bb0826) whenever red text sits on the dimmed map background — plain `--pokedex-red` measures 3.78:1 there and fails WCAG AA.
- **Do** use `--gb-hint` (#6d707c) for the smallest caption/hint text on paper, not the old #7a7d8a value, which fails 4.5:1.
- **Do** pair LCD green background with LCD green-dark text as one unit; never split the pair.
- **Do** provide a `prefers-reduced-motion` alternative for every animation (matching the pattern already in gate.css/popup.css).
- **Do** keep Spare Green and the "Spare it" action as the system's one rare affirmative color.

### Don't:
- **Don't** introduce gradient buttons, coin-shower particle juice, or any modern F2P/gacha mobile-game chrome — this is the system's named anti-reference.
- **Don't** let flat modern SaaS drift in: no soft blurred shadows, no rounded cards as a default shape, no clean sans-serif creeping into any new screen.
- **Don't** scale Press Start 2P above ~14px, and don't introduce a second typeface for "readability."
- **Don't** use `border-left`/`border-right` as a colored accent stripe on any card or list row — this system's cards use full borders or nothing.
- **Don't** apply `background-clip: text` gradients to headings; emphasis comes from Poké Red color or spacing, never a gradient.
- **Don't** use plain `--pokedex-red` for text directly against `--bezel` or the settings map veil — it fails contrast; use `--pokedex-red-heading` instead.
- **Don't** design the UI as if it enforces anything — no "locked," "blocked," or punitive chrome that reads as a technical wall rather than an honest honor-system nudge.
