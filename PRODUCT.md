# Product

## Register

product

## Platform

web

## Users

Today it's a single sophisticated user (the builder) running the unpacked extension for personal, non-commercial use — someone who already knows the mechanic and doesn't need onboarding. The design should hold up as it grows toward a public audience later: a stranger loading the unpacked build for the first time should be able to read the gate, the Dodgédex, and the settings page without prior explanation, even though the immediate audience is one person.

## Product Purpose

dodgy deters distracting-website use through an emotional commitment device — a Pokémon guardian that flees the cursor at the point of temptation. It exists to create a moment of friction and genuine feeling right before a person breaks their own rule, not to enforce a technical block. Success isn't a metric trending down; it's that the chase-and-guilt beat exists at all, every single time, giving the user a real pause before pushing through.

## Positioning

It makes you feel something before you break your own rule. A blocker says no; dodgy makes the cost personal — a creature you've grown and are attached to gets hurt — so restraint is chosen, not imposed.

## Brand Personality

Playful and retro first: Game Boy-era Pokédex nostalgia, collectible and a little silly, chunky pixel dialogs and Press Start 2P type carrying most of the charm. The guilt mechanic sits underneath as real emotional weight, but the surface tone stays light — this is a companion you're fond of, not a scold. Specific lineage: Gen 2/3 Pokédex UI (HGSS portraits, red dex-shell chrome) and PMD SpriteCollab overworld sprites — stay inside that exact visual family rather than pulling in outside pixel-art references.

## Anti-references

Two drift directions to actively guard against as new screens get added:
- **Generic mobile gacha/idle game**: no slick gradient buttons, coin-shower juice, or modern F2P-App-Store chrome. Rewards (coins, eggs, evolution) stay period-correct GB/Pokédex, not mobile-game skinning.
- **Flat modern SaaS**: no drift toward clean sans-serif type, soft shadows, or rounded card UI. Every surface — including future ones — keeps the chunky double-black-border dialog language, not a generic dashboard look.

## Design Principles

- Stay inside the Gen 2/3 Pokédex + PMD lineage — when in doubt, match what HGSS/PMD would actually render, not generic pixel-art.
- Guilt is a feeling, not a punishment — tone stays warm and playful even at the mechanic's sharpest moments (low HP, faint, permadeath).
- No enforcement theater — the UI should never pretend to be a technical wall; it's honest about being an honor-system nudge.
- Every screen a stranger could land on cold — even though today's user is one person, don't design anything that requires having read the README first.
- Chunky and committed, never flat — double-black-border dialogs, pixelated rendering, and Press Start 2P are load-bearing brand signals, not decoration to simplify away.

## Accessibility & Inclusion

WCAG AA contrast (4.5:1 body text, 3:1 large text) across all three surfaces, including the pixel-red-on-dark and LCD-green-on-dark combinations already in use — verify, don't assume the retro palette clears this by default. The chase/click mechanic's difficulty slider and 30-second auto-ease already provide an accessible floor for users who can't sustain fast precise clicking; keep that guarantee intact in any future chase changes. `prefers-reduced-motion` alternatives are required for all motion, matching what's already implemented in gate.css and popup.css.
