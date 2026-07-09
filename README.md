# dodgy

> *Ah, a new trainer! The web is full of tall grass — distracting sites lurk there, ready to swallow your afternoon. But you won't be walking through it alone.*

**dodgy** is a Chrome (Manifest V3) extension that deters distracting-website use through an emotional commitment device — with a Pokémon guardian at your side. Your only rival here is your own dopamine.

You pick a starter (Charmander, Squirtle, or Bulbasaur). It becomes your **guardian**: when you try to open a blocked site, it appears and flees your cursor across the screen. To get through you must catch it with a single click, then look it in the eye and confirm — every push-through costs 1 HP. Restraint is the real training here.

The stakes go up from there:

- **Restraint grows your guardian.** Any day you push through fewer than a few times, the active guardian gains a level toward **real evolution thresholds** and you earn **PokéCoins**.
- **Coins buy eggs.** Spend coins in the shop on a species egg, incubate it over clean days, and hatch it into your party.
- **Drain its HP to 0 and it faints.** A fainted guardian loses levels (never devolving) and every blocked site locks out until local midnight. **Three faints in a row is permadeath** — that Pokémon is gone for good. Train responsibly.

Your progress lives in the **Dodgédex** — a Pokédex-styled toolbar popup showing your guardian, HP, evolution progress, coins, egg incubation, and party. dodgy is an honor-system nudge, not a technical wall.

## Quick start

```bash
npm install    # install dev dependencies
npm run assets # fetch Pokémon sprites, portraits, and species data (once)
npm run build  # typecheck + build to dist/
```

Then load the built extension:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `dist/` directory.

### Choose your first partner

On first run, opening a blocked site prompts you to pick your free starter — Charmander, Squirtle, or Bulbasaur. Choose well; it's yours from here.

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

**Credits & IP:** every sprite contributor and data/font source is listed in the generated `CREDITS.md`, which ships in `dist/assets/pokemon/CREDITS.md` after a build. This is a fan-made project for **personal, non-commercial use** — it is not affiliated with, sponsored by, or endorsed by Nintendo, Game Freak, or The Pokémon Company. Nothing in the engine depends on the sprites being Pokémon; the mechanics reskin to original creatures if you ever want to publish.

## How it works (behind the gym doors)

A background service worker owns all state (HP, level, lockout, grace passes) and is the single source of truth. Blocked navigations are intercepted **before load** by `declarativeNetRequest` dynamic rules (one redirect rule per blocked domain, subdomain-inclusive, `main_frame` only) and redirected to a full-screen extension **gate page**, so there's no flash of the target site and no fighting hostile third-party CSP.

On the gate you **chase** your guardian, **catch** it, then choose:

- **Continue** — deal 1 damage, get a grace pass for that domain, and load the real site.
- **Spare it** — no damage, a happy thank-you, and back to where you were.

Four product decisions govern the mechanics:

- **Grace window: 15 minutes.** After a paid entry, that domain loads freely for 15 min before the guardian re-guards it (so reloads don't cost HP).
- **Fatal hit is honored.** The faint-causing blow still grants that domain's grace pass and loads the site one last time. The lockout hits every *other* domain immediately; the fatal domain's pass survives until its normal expiry.
- **Multi-day gaps count as one clean day.** Time away counts as restraint, but a week offline is still just one level (and one egg-day), not seven.
- **Chase auto-ease starts at 30s.** Speed is always capped and eases after 30 seconds of failed chasing, so no one is ever hard-stuck (accessibility).

At local midnight, HP resets to full. If the completed day had fewer than `levelUpThreshold` paid entries, the active guardian gains a level (auto-evolving when it crosses a species threshold), any incubating egg advances one day, and you earn PokéCoins scaled by restraint. Only one guardian may take damage per day; you can switch guardians only *before* the day's first push-through.

## Settings (your Trainer Card)

Open the extension's options page (gear icon in the Dodgédex popup) to tune the rules your guardian lives by:

- **Pokédex title** — the label shown across the top of your popup (default *Dodgédex*).
- **Max HP** — push-throughs it takes to faint the guardian in one day (lowering this clamps current HP down).
- **Damage per entry** — HP lost per push-through.
- **Level-up threshold** — level up (and earn coins / advance an egg) on any day with fewer than this many push-throughs.
- **Grace minutes** — how long a paid site stays open before re-guarding.
- **Starter level** — level a fresh starter or newly-hatched Pokémon begins at.
- **Faint level penalty** — levels lost on a faint (floored at the current stage — it never devolves).
- **Faints to permadeath** — consecutive faints before a guardian is gone for good.
- **Base reward** — PokéCoins earned for a fully clean day.
- **Egg cost** — coins one species egg costs at the shop.
- **Days to hatch** — clean days needed to hatch an egg (messy days don't reset progress).
- **Blocklist** — add/remove domains (normalized to eTLD+1, subdomain-inclusive) or reset to defaults.

Numeric fields validate client-side (integers with per-field minimums, mirroring the service worker) and **Save** stays disabled while any field is invalid.

## Dev commands

| Command | What it does |
|---|---|
| `npm run assets` | Fetch Pokémon sprites, portraits, and species data into `public/assets/` (add `--force` to re-download). |
| `npm run build` | Typecheck, then build to `dist/` (gated by `check-assets`). |
| `npm run dev` | Vite build in watch mode. |
| `npm test` | Run the Vitest unit suite. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run check-assets` | Verify the packaged asset tree offline (no network). |

## Project structure

```
src/
  background/   service worker: state machine, storage, DNR rules, alarms
  gate/         full-screen gate page: chase, guilt, spared, faint, permadeath, lockout
  popup/        Dodgédex popup: guardian, party, egg shop, incubator
  settings/     options page: settings form + blocklist management
  shared/       messages, types, constants, species data, domains, sprite engine
public/
  manifest.json
  fonts/        Press Start 2P (OFL-licensed, committed)
  assets/       Pokémon sprites/portraits/species.json (fetched, gitignored)
scripts/        fetch-assets.mjs (build-time fetch) + check-assets.mjs (offline gate)
```

## v1 scope & non-goals

- **Personal, unpacked use.** v1 targets loading `dist/` unpacked for your own use, with fan-sourced sprites bundled locally and credited.
- **Honor system, no anti-cheat.** Disabling the extension or rolling the system clock defeats it. That's accepted — dodgy is an emotional nudge, not enforcement.
- **Local-only.** State lives in `chrome.storage.local`; there is no account and no cross-device sync.
- **Three starter lines only.** Charmander / Squirtle / Bulbasaur. Roster expansion is a data-only add later via `species.json`.
- No trading, battling, shinies, breeding, streak insurance, payments, or in-site SPA interception — deferred to v2+.
