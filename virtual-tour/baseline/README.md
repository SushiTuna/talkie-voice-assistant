# UI/UX baseline — before the Lit migration

Captured from commit `0167fd2` (branch `migrate-to-lit`), before any Lit code.

## Re-capture / compare

```sh
npm start                                   # server on :8080
node baseline/capture.mjs                   # overwrites baseline/current (the baseline)
node baseline/capture.mjs baseline/after    # capture post-migration state beside it
```

Headless Chrome over CDP (same approach as `tests/cdp-shot.mjs`), no extra deps. Scroll-reveal
animations are forced to their end state and lazy images/map tiles are loaded before shots.

## What's in `current/`

- `screenshots/` — for each of `desktop` (1440×900) and `mobile` (390×844 @2x, touch) × `dark`/`light`:
  `*-above-fold.png`, `*-full.png`, `*-section-<id>.png` (top, floor-plan, highlights, tour-section,
  residence, location, contact). Dark runs also have `*-form-errors.png` (empty submit) and
  `*-tour-started.png` (3D view + room dock after Start).
- `report.json` — per run: landmarks, headings, every interactive element (accessible name, size,
  visibility), images, all element ids, CSS custom-property values, horizontal-overflow check;
  dark runs add keyboard Tab order (first 40 stops), form-validation behaviour and 3D tour HUD state.
  Plus console warnings/errors.

## Key facts to preserve

| | desktop | mobile |
|---|---|---|
| Page height (px) | 7970 | 9920 |
| Horizontal overflow | none | none |
| Headings / interactive elements | 15 / 130 | 15 / 130 |
| Broken images | 0 | 0 |
| CSS custom properties | 27 | 27 |
| Custom elements | none | none |

- **Form validation (empty submit):** error summary shown and focused (`#errorSummary`) listing day,
  time, name, email, phone; `f-name`, `f-email`, `f-phone` get `aria-invalid=true`.
- **3D tour after Start:** starts at "Exterior", dock shows `2 / 16`. Desktop badge
  "Walk mode — click the view to take control"; mobile "Room view — tap the view to look around".
- **Keyboard order (desktop, after page load; the 3D canvas `#renderCanvas` is the first stop):** header logo → nav (Floor plan, Tour, Residence, Location, Contact) →
  theme toggle → Schedule a tour → hero CTAs → floor-plan rooms… (see `report.json`).
- **Console:** only a known warning on touch devices ("broadleaf trees unavailable… skipped on touch devices").
