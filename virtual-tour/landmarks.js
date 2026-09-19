// Property location and nearby landmarks for the contact-section map (neighborhood.js).
// Location: the GPS point supplied for the listing; the area name is OpenStreetMap's reverse
// geocode of it (Nominatim: "Balenben Road, Balenben, Irisan, … Baguio").
// Landmarks: the nearest named places per category from an OpenStreetMap Overpass query around
// that point (2026-09-19). Tags used: amenity=police; amenity=school|college; amenity=hospital;
// shop=mall; amenity=place_of_worship + religion=christian. `osm` is the element id, so each one
// can be checked at https://www.openstreetmap.org/<type>/<id>. Distances are computed in the page
// (straight line), not stored. Map data © OpenStreetMap contributors, ODbL.
export const PROPERTY = {
  lat: 16.4213791,
  lng: 120.5592925,
  area: "Balenben, Irisan, Baguio City",
};

export const CATEGORIES = [
  { id: "police", label: "Police" },
  { id: "school", label: "Schools" },
  { id: "hospital", label: "Hospitals" },
  { id: "mall", label: "Malls" },
  { id: "church", label: "Churches" },
];

export const LANDMARKS = [
  { cat: "police", name: "Tadiangan COMPAC Police Station", lat: 16.409234, lng: 120.554043, osm: "way/518697743" },
  { cat: "police", name: "Irisan Police Station", lat: 16.430101, lng: 120.548645, osm: "node/11150274050" },
  { cat: "police", name: "Baguio City Police Office Mobile Patrol Unit", lat: 16.421672, lng: 120.577576, osm: "node/11154658694" },

  { cat: "school", name: "Westville School", lat: 16.417514, lng: 120.557757, osm: "way/1133428865" },
  { cat: "school", name: "Philippine Science High School – CAR Campus", lat: 16.416516, lng: 120.562532, osm: "relation/14205451" },
  { cat: "school", name: "Baguio City National Science High School", lat: 16.415795, lng: 120.561344, osm: "relation/15569814" },
  { cat: "school", name: "San Carlos Heights Elementary School", lat: 16.414372, lng: 120.563497, osm: "relation/13567051" },
  { cat: "school", name: "Baguio Benguet Christian Colleges", lat: 16.43004, lng: 120.546692, osm: "way/573227358" },

  { cat: "hospital", name: "Pines City Doctors' Hospital", lat: 16.42688, lng: 120.594657, osm: "relation/18673613" },
  { cat: "hospital", name: "Cordillera Hospital of the Divine Grace", lat: 16.45267, lng: 120.574701, osm: "way/501299848" },

  { cat: "mall", name: "Cooyeesan Hotel Plaza", lat: 16.412832, lng: 120.578546, osm: "way/43766156" },
  { cat: "mall", name: "Abanao Square", lat: 16.414076, lng: 120.594162, osm: "way/190914335" },
  { cat: "mall", name: "Baguio Center Mall", lat: 16.416389, lng: 120.596358, osm: "way/159128818" },

  { cat: "church", name: "Seventh Day Adventist Church", lat: 16.420935, lng: 120.55821, osm: "way/676544956" },
  { cat: "church", name: "Jesus at the Center Christian Church", lat: 16.42322, lng: 120.560108, osm: "node/10772034138" },
  { cat: "church", name: "Iglesia Ni Cristo", lat: 16.418004, lng: 120.557374, osm: "relation/13370665" },
  { cat: "church", name: "Saint Joseph Parish Irisan", lat: 16.424837, lng: 120.550603, osm: "way/304768730" },
];
