// Room viewpoints for the 3D tour (world space AFTER main.js scale normalisation).
// pos = eye position [x, y, z] (y = floor + 1.6 m eye height); yaw = rotation.y (0 looks toward +z, PI/2 toward +x);
// pitch = rotation.x (positive looks down). Derived from a top-down cutaway of the model and verified with a
// first-person screenshot per anchor (see tests/anchor-shots.mjs). Edit here to adjust a view.
// The model has an open carport under the raised house ("Garage") and a balcony deck, but no separate patio.
export const DOLLHOUSE = { id: "dollhouse", label: "Dollhouse", group: "Overview", caption: "Orbit the whole house (V)" };

export const ROOM_ANCHORS = [
  {id: "exterior", label: "Exterior", group: "Outside", caption: "The raised home, carport and balcony deck from the lawn", pos: [-17.015,-1.745,11.434], yaw: 2.370, pitch: -0.079},
  {id: "garage", label: "Garage", group: "Outside", caption: "Open carport under the house (2 cars)", pos: [-4.5,-1.632,9], yaw: 3.142, pitch: 0.08},
  {id: "balcony", label: "Balcony", group: "Outside", caption: "Timber deck with pergola off the living area", pos: [-11,1.224,0.5], yaw: -0.588, pitch: 0.08},
  {id: "lounge", label: "Lounge", group: "Living", caption: "Lounge with a full-height picture window", pos: [-9.5,1.224,-0.6], yaw: -2.135, pitch: 0.08},
  {id: "dining", label: "Dining", group: "Living", caption: "Six-seat dining beside the lounge", pos: [-4.8,1.224,-0.5], yaw: -2.229, pitch: 0.08},
  {id: "kitchen", label: "Kitchen", group: "Living", caption: "Island kitchen with butler's pantry", pos: [-5,1.224,0.2], yaw: -0.896, pitch: 0.08},
  {id: "rumpus", label: "Rumpus", group: "Living", caption: "Second living area / rumpus room", pos: [4.2,1.224,-0.5], yaw: -2.129, pitch: 0.08},
  {id: "study-nook", label: "Study Nook", group: "Living", caption: "Built-in desk study nook", pos: [0.8,1.224,-2.2], yaw: -1.756, pitch: 0.12},
  {id: "master-bedroom", label: "Master Bedroom", group: "Bedrooms", caption: "Master suite with walk-in robe and ensuite", pos: [9.6,1.224,3.3], yaw: 2.214, pitch: 0.08},
  {id: "room-1", label: "Room 1", group: "Bedrooms", caption: "Bedroom 2, set up as a nursery", pos: [5.9,1.224,0.8], yaw: 0.862, pitch: 0.08},
  {id: "room-2", label: "Room 2", group: "Bedrooms", caption: "Bedroom 3 with double bed", pos: [4.4,1.224,0.4], yaw: -0.464, pitch: 0.08},
  {id: "room-3", label: "Room 3", group: "Bedrooms", caption: "Bedroom 4 with double bed", pos: [-0.4,1.224,0.4], yaw: -0.588, pitch: 0.08},
  {id: "ensuite", label: "Ensuite", group: "Wet areas", caption: "Master ensuite with shower and vanity", pos: [9.9,1.224,-1.6], yaw: -2.871, pitch: 0.25},
  {id: "bathroom", label: "Bathroom", group: "Wet areas", caption: "Main bathroom with freestanding bath", pos: [7,1.224,-1.7], yaw: -2.802, pitch: 0.3},
  {id: "laundry", label: "Laundry", group: "Wet areas", caption: "Laundry with washer and dryer", pos: [-4.1,1.224,-3.2], yaw: 0.571, pitch: 0.15},
];

export const ANCHOR_GROUPS = ["Outside", "Living", "Bedrooms", "Wet areas"];
