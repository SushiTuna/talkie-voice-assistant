// All listing copy lives in this ONE object (placeholders only — no invented address/agent/price).
// Facts come from the model's floor: single-level home raised on posts; 4 bedrooms (Master +
// Rooms 1–3), master with walk-in robe + ensuite; main bathroom with freestanding bath + separate
// WC; laundry; open-plan kitchen (island, butler's pantry) / dining / lounge; rumpus; study nook;
// balcony deck; carport under the house for 2 cars. No floor area is quoted (not measured).
export const listing = {
  name: "Modular House Cube 3",
  wordmark: ["Modular House", "Cube 3"],
  eyebrow: "[Listing status] · Modular home",
  tagline: "A single-level home raised on posts — four bedrooms, open-plan living and a timber deck.",
  price: "Price on request",
  address: "[Property address]",
  agent: {
    name: "[Agent name]",
    phone: "[Agent phone]",
    email: "[agent@email]",
  },
  // Hero facts line: beds · baths · living areas · balcony
  factsLine: "4 bedrooms · 2 bathrooms + WC · 3 living areas · balcony deck",
  facts: [
    { label: "Bedrooms", value: "4" },
    { label: "Bathrooms", value: "2 + WC" },
    { label: "Living areas", value: "3" },
    { label: "Outdoor", value: "Balcony deck" },
  ],
  intro:
    "Delivered as a modular build and set on its own raised footprint, this home keeps every room on one level. The heart of it is the open-plan kitchen, dining and lounge — anchored by an island with a butler's pantry behind and framed by a full-height picture window, with the timber balcony deck just off the living area. Four bedrooms sit in their own wing, led by a master suite with walk-in robe and ensuite, alongside a second living rumpus, a built-in study nook, a main bathroom with freestanding bath, a separate WC and a full laundry. Under the house, an open carport parks two cars out of the weather.",
  highlights: [
    { label: "Layout", value: "Single-level, raised on posts" },
    { label: "Master suite", value: "Walk-in robe + ensuite" },
    { label: "Kitchen", value: "Island + butler's pantry" },
    { label: "Parking", value: "Carport for two under home" },
  ],
  // Gallery cards: anchor ids (see anchors.js) — copy + images derive from these.
  galleryIds: ["lounge", "kitchen", "dining", "master-bedroom", "balcony", "garage"],
  reassurance: "[Response-time promise, e.g. \"We reply within one business day to confirm your time.\"]",
};
