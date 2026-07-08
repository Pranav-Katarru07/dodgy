# dodgy

**dodgy** is a Chrome (Manifest V3) extension that deters distracting-website use through an emotional commitment device. When you try to open a blocked site, a small creature — dodgy — appears and flees your cursor across the screen. To get through you must catch it with a single click, then look it in the eye and confirm you want to hurt it. Every push-through costs 1 HP; dodgy heals fully each day and levels up on days you show restraint, so over weeks you grow a companion you're attached to. Drain all its HP in one day and you kill it: every distracting site locks out for 24 hours and the leveled-up pet you invested weeks in resets to level 0. dodgy is an honor-system nudge, not a technical wall.

## Install from source

```bash
npm install
npm run build
```

Then load the built extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `dist/` directory.

## Assets

The Pokémon-themed build needs sprite sheets, portraits, and species data that are **not checked into this repo**. Fetch them once, before your first build:

```bash
npm run assets
```

This runs `scripts/fetch-assets.mjs`, which downloads everything into `public/assets/pokemon/` (gitignored):

- **Species data** (names, types, dex flavor text, evolution levels) from [PokéAPI](https://pokeapi.co/), baked into a static `species.json`.
- **Pokédex portraits** from [PokéAPI/sprites](https://github.com/PokeAPI/sprites) (HGSS gen-IV art, with a fallback to the default sprite).
- **Overworld walk/idle sprite sheets** from [PMD SpriteCollab](https://sprites.pmdcollab.org/) ([GitHub](https://github.com/PMDCollab/SpriteCollab)).
- An auto-generated `CREDITS.md` listing every sprite contributor plus data/font sources.

The fetch is idempotent (re-run any time; add `--force` to re-download) and never runs at extension runtime — the extension makes **zero** network calls. `npm run build` and `npm run dev` are gated by `scripts/check-assets.mjs`, which verifies the tree offline and, if it's missing, tells you to run `npm run assets`. Vite copies `public/assets/**` into `dist/assets/**`, so `CREDITS.md` ships alongside the packaged art.

**Why gitignored:** these are fan-sourced assets, so no Nintendo IP lives in the public repo. The `public/fonts/` directory (Press Start 2P) *is* committed, because it's licensed under the SIL Open Font License, not Nintendo IP.

**Non-affiliation:** this is a fan-made project for personal, non-commercial use. It is not affiliated with, sponsored by, or endorsed by Nintendo, Game Freak, or The Pokémon Company.

## How it works

A background service worker owns all state (HP, level, lockout, grace passes) and is the single source of truth. Blocked navigations are intercepted **before load** by `declarativeNetRequest` dynamic rules (one redirect rule per blocked domain, subdomain-inclusive, `main_frame` only) and redirected to a full-screen extension **gate page**, so there's no flash of the target site and no fighting hostile third-party CSP.

On the gate you **chase** dodgy, **catch** it, then choose:

- **Continue** — deal 1 damage, get a grace pass for that domain, and load the real site.
- **Let dodgy live** — no damage, a happy thank-you, and back to where you were.

Four product decisions govern the mechanics:

- **Grace window: 15 minutes.** After a paid entry, that domain loads freely for 15 min before dodgy re-guards it (so reloads don't cost HP).
- **Fatal hit is honored.** The killing blow still grants the fatal domain's grace pass and loads that site one last time. The lockout hits every *other* domain immediately; the fatal domain's pass survives the lockout until its normal expiry.
- **Multi-day gaps award at most +1 level total.** Time away counts as restraint, but a week offline is still just one level, not seven.
- **Chase auto-ease starts at 30s.** Speed is always capped and eases after 30 seconds of failed chasing, so no one is ever hard-stuck (accessibility).

At local midnight HP resets to full and, if the completed day had fewer than `levelUpThreshold` paid entries, dodgy gains a level. Every `levelsPerEvolution` levels it evolves to a new sprite tier.

## Settings

Open the extension's options page (gear icon in the popup) to edit:

- **Max HP** — push-throughs it takes to kill dodgy in one day (lowering this clamps current HP down).
- **Damage per entry** — HP lost per push-through.
- **Level-up threshold** — grow on any day with fewer than this many push-throughs.
- **Levels per evolution** — levels between evolution tiers.
- **Grace minutes** — how long a paid site stays open before re-guarding.
- **Lockout hours** — lockout duration after death.
- **Blocklist** — add/remove domains (normalized to eTLD+1, subdomain-inclusive) or reset to defaults.

Numeric fields validate client-side (integers with per-field minimums, mirroring the service worker) and **Save** stays disabled while any field is invalid.

## Dev commands

| Command | What it does |
|---|---|
| `npm run build` | Typecheck, then build to `dist/`. |
| `npm run dev` | Vite build in watch mode. |
| `npm test` | Run the Vitest unit suite. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run sprites` | Regenerate placeholder sprite sheets + manifest into `public/sprites/`. |

## Project structure

```
src/
  background/   service worker: state machine, storage, DNR rules, alarms
  gate/         full-screen gate page: chase, guilt, spared, lockout, death
  popup/        toolbar popup: the pet's home (HP, level, countdown)
  settings/     options page: settings form + blocklist management
  shared/       messages, types, constants, domain normalization, sprite engine
public/
  manifest.json
  sprites/      placeholder art (tier 0 + tier 1) + manifest.json
scripts/        zero-dependency sprite-sheet generator
```

## v1 non-goals

- **Honor system, no anti-cheat.** Disabling the extension or rolling the system clock defeats dodgy. That's accepted — dodgy is an emotional nudge, not enforcement.
- **Local-only.** State lives in `chrome.storage.local`; there is no account and no cross-device sync.
- No streak insurance, payments, in-site SPA interception, or multiple pets — those are deferred to v2+.
