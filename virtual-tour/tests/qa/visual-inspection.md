# Visual inspection — issues noted (no fixes applied)

Date: 2026-09-18 · Inspected by: orchestrator (Claude), by eye, from the screenshots listed per item.
Scope: the final page after Copilot Phases 3–5 + the Copilot verifier run (`tests/qa/`, 18/26 checks passed).
The Copilot verifier's model could not view images, so every visual verdict below is from this inspection.

## A. Verdicts on the verifier's findings

| Verifier item | Verdict | Evidence |
|---|---|---|
| A3 "9 anchors inside solid geometry" (FAIL) | **False positive.** All 15 room views show the named room with a clear view; none is in a wall. | `tests/qa/anchor-*.png` (sheet: `.tmp/shots/vi-anchors.png`) |
| A3 "renders 20–40 luminance darker than reference" | Not visible as a problem; views look correctly exposed. | same |
| D1 full-page review (PARTIAL, "human look BLOCKED") | Done here — see section B. | `tests/qa/page-1440.png`, `page-390.png` |
| D6 floor plan (FAIL) | **Confirmed**, plus two more defects (B6, B7). | `tests/qa/plan-1440.png` |
| E1 21.5 MB model loads at scroll 0 (FAIL) | **Confirmed** (code: `main.js` lazy IntersectionObserver `rootMargin: "0px 0px 100% 0px"`). Root cause is the orchestrator's brief ("within 1 viewport"), which the implementer followed. | verifier report |
| E5 "four wings" / "their own wing" (FAIL) | **Confirmed.** `index.html` floor-plan heading and `listing.js` intro. | page-1440 |
| B3 scroll shifts −160 px after exiting fullscreen (PARTIAL) | Accepted (numeric; not visually checkable). | verifier report |
| D5 model credit 3.18:1 contrast (PARTIAL) | **Confirmed visually** — the credit is tiny grey text over the live scene and hard to read, worst on mobile (B1). | page-1440, page-390 |
| D3 headings render in Inter, not Inter Tight (PARTIAL) | Accepted (computed-style check; `styles.css` `var(--font-body, inherit)` invalidates the declaration). Visually the headings still look clean. | verifier report |

## B. New issues found by eye (most severe first)

1. **HIGH — Mobile tour frame is cramped and overlapping** (`page-390.png`, tour section).
   The "Walk mode — click the view to take control" badge runs under the FULLSCREEN button; the centred
   "Click the view to take control" pill overlaps the model credit, which wraps to 4 lines across the scene;
   only 2 anchor pills (Dollhouse, Exterior) are visible. The tour is the page's main feature and is hard to use at 390 px.

2. **MEDIUM — First view of the tour is dark and unflattering** (`page-1440.png` tour section).
   Before any anchor is chosen the camera sits at the default spawn under the house: the dark underside fills the
   top half and a black post the right third. The Exterior anchor would be a far better opening frame.

3. **MEDIUM — "Click the view to take control" pill sits dead-centre on every view** (`tests/qa/anchor-*.png`, `fullscreen.png`).
   It covers the subject of each room (e.g. the dining table, the crib) and stays visible even after choosing an anchor.

4. **MEDIUM — Dollhouse view frames the neighbourhood, not the house** (`tests/qa/anchor-dollhouse.png`).
   The house is a small object in the middle of the frame (~15 % of the image); the surrounding streets dominate.

5. **MEDIUM — Floor plan layout is wrong** (confirms D6; `plan-1440.png`).
   Three bands with a "Hall" block, versus the real two rows either side of a long hallway
   (south: Lounge · Dining · Laundry · Study Nook · Rumpus · WC · Bath · Ensuite · WIR;
   north: Balcony · Kitchen · Pantry · Room 3 · WIR · Room 2 · Room 1 · Master). WC and pantry missing.

6. **MEDIUM — Balcony and Garage boxes on the floor plan have no visible labels** (`plan-1440.png`).
   The left box (balcony) and the box below the plan (garage) are empty rectangles; the markup contains
   "Carport · 2 cars (under home)" but it does not render, so users can't tell what they are or that they're clickable.

7. **LOW — "BATH FREESTANDING" label overflows its cell** (`plan-1440.png`) — text touches/crosses the right cell border.

8. **LOW — Mobile floor plan is clipped with no scroll hint** (`page-390.png`, floor-plan section).
   Only the left third of the plan is visible (Lounge, Laundry, Study Nook, Dining, Kitchen); the caption
   "SCHEMATIC LAYOU…" is cut. The frame scrolls horizontally but nothing signals that.

9. **LOW — Anchor pill bar is cut off with no scroll affordance** (`page-1440.png`, `anchor-*.png`).
   On desktop the bar ends mid-word ("Master Bedr…"); there is no fade, arrow or hint that more rooms follow.

10. **LOW — Confirmation card shows the date in ISO format** (`form-confirm.png`): "2026-09-24" rather than a
    human date (e.g. "Thu 24 Sep 2026").

11. **LOW — Duplicate visible success text** (`form-confirm.png`): "Your tour request was sent successfully." is shown
    as a visible line under the confirmation card (it reads like the screen-reader live-region text leaking into view).

12. **LOW — Mobile header wraps** (`page-390.png`): the wordmark splits over two lines ("Modular / House" + "CUBE 3")
    and the header button wraps to "SCHEDULE A / TOUR".

13. **LOW — Gallery card links don't align** (`page-1440.png`, residence grid): "VIEW IN 3D" sits at different heights
    in cards whose captions wrap to 1 vs 2 lines.

14. **NOTE — Placeholders are visible to visitors by design** ("[Listing status]", "[Agent name]", "[Response-time promise…]",
    "[agent@email]"). They must be replaced with real details before the page is shared.

## C. Checked and fine
- All 15 room anchors land in the correct room (A3 above); active pill highlights correctly.
- Fullscreen: exit button, anchor bar and credit visible; scene fills the screen (`fullscreen.png`).
- Form validation: every required field shows a clear red error message and border (`form-errors.png`).
- Focus ring: clearly visible on anchor pills (`focus-ring.png`).
- Design matches the brief's Kononenko-inspired direction on desktop: off-white background, black ink, large tight
  headings, uppercase letter-spaced labels, black primary buttons, full-bleed hero with overlaid title, thin dividers,
  generous whitespace; all imagery is real renders of the model.
- No horizontal page scroll at 1440 / 768 / 390 (verifier D2, consistent with the screenshots).
