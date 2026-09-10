"use strict";

const STALE_SECONDS = 300;
const POLL_MS = 4000;
// Optional live-push notification from mqtt-bridge/mqtt_to_mysql.py's
// WebSocket server (see its README's "Live push" section) -- when set,
// an incoming message triggers an immediate refresh() instead of waiting
// for the next POLL_MS tick, which stays running regardless as the
// reliable fallback (a missed/dropped WebSocket message just means the
// next poll catches it up to POLL_MS later, same as if this were unset).
// Empty by default: there's no server-side templating in this static
// HTML setup to inject it automatically, so point it at wherever that
// service's --ws-host/--ws-port are reachable from your browser, e.g.
// "ws://192.168.0.10:8765".
const WS_URL = "";
const VIEW_COOKIE = "citsMapView";
const EXPIRED_HOURS_COOKIE = "citsExpiredHours";
const PANEL_COLLAPSED_COOKIE = "citsPanelCollapsed";
const LAYER_VISIBILITY_COOKIE = "citsLayerVisibility";
const SECTION_COLLAPSED_COOKIE = "citsSectionCollapsed";
const CLUSTERING_COOKIE = "citsClusteringEnabled";
const MAX_EXPIRED_HOURS = 7 * 24;

function apiUrl() {
	const expiredHours = parseInt(document.getElementById("expired-hours-slider").value, 10) || 0;
	const heatmapOn = document.getElementById("option-heatmap").checked;
	return "api.php?stale=" + STALE_SECONDS + (expiredHours > 0 ? "&expired_hours=" + expiredHours : "") +
		(heatmapOn ? "&heatmap=1" : "");
}

// ETSI CDD StationType (subset actually seen in the wild; unmapped codes
// fall back to a generic "Type N" label).
const STATION_TYPES = {
	0: { name: "Unknown", shape: "dot" },
	1: { name: "Pedestrian", shape: "pedestrian" },
	2: { name: "Cyclist", shape: "bike" },
	3: { name: "Moped", shape: "bike" },
	4: { name: "Motorcycle", shape: "bike" },
	5: { name: "Passenger Car", shape: "car" },
	6: { name: "Bus", shape: "bus" },
	7: { name: "Light Truck", shape: "truck" },
	8: { name: "Heavy Truck", shape: "truck" },
	9: { name: "Trailer", shape: "truck" },
	10: { name: "Special Vehicle", shape: "car" },
	11: { name: "Tram", shape: "tram" },
	15: { name: "Road Side Unit", shape: "rsu" },
};

function stationTypeInfo(t) {
	if (t === null || t === undefined) return { name: "Unknown", shape: "dot" };
	return STATION_TYPES[t] || { name: "Type " + t, shape: "dot" };
}

// ETSI TS 102894-2 CauseCodeType -- common subset, best-effort labels.
//
// Codes 91-95 here were previously off by the "reserved" gap the real enum
// has between 27 and 91 handled wrong: the actual assignment is
// vehicleBreakdown(91), postCrash(92), humanProblem(93), stationaryVehicle
// (94), emergencyVehicleApproaching(95), hazardousLocation-DangerousCurve
// (96), collisionRisk(97), signalViolation(98), dangerousSituation(99),
// railwayLevelCrossing(100) -- confirmed against cdd_1_3_1_1.asn's
// CauseCodeType and cdd_2_2_1.asn's CauseCodeChoice in mqtt-bridge/asn1.
// publicTransportVehicleApproaching is cause code 28, not 95.
const CAUSE_CODES = {
	1: "Traffic Condition", 2: "Accident", 3: "Roadworks",
	6: "Adverse Weather Condition - Adhesion",
	9: "Hazardous Location - Surface Condition",
	10: "Hazardous Location - Obstacle On The Road",
	11: "Hazardous Location - Animal On The Road",
	12: "Human Presence On The Road",
	14: "Wrong Way Driving",
	15: "Rescue And Recovery Work In Progress",
	17: "Adverse Weather Condition - Extreme Weather Condition",
	18: "Adverse Weather Condition - Visibility",
	19: "Adverse Weather Condition - Precipitation",
	20: "Violence",
	26: "Slow Vehicle",
	27: "Dangerous End Of Queue",
	28: "Public Transport Vehicle Approaching",
	91: "Vehicle Breakdown",
	92: "Post-Crash",
	93: "Human Problem",
	94: "Stationary Vehicle",
	95: "Emergency Vehicle Approaching",
	96: "Hazardous Location - Dangerous Curve",
	97: "Collision Risk",
	98: "Signal Violation",
	99: "Dangerous Situation",
	100: "Railway Level Crossing",
};

function causeCodeName(c) {
	if (c === null || c === undefined) return null;
	return CAUSE_CODES[c] || ("Cause code " + c);
}

// SubCauseCode*, keyed by cause code -- same source (mqtt-bridge/asn1's
// cdd_1_3_1_1.asn / cdd_2_2_1.asn) as CAUSE_CODES above. Only covers cause
// codes that have a named sub-cause enum at all (several, like Violence(20)
// and Public Transport Vehicle Approaching(28), are just a bare integer
// with no ETSI-assigned meanings).
const SUB_CAUSE_CODES = {
	1: { 0: "unavailable", 1: "increased volume of traffic", 2: "traffic jam slowly increasing", 3: "traffic jam increasing", 4: "traffic jam strongly increasing", 5: "traffic stationary", 6: "traffic jam slightly decreasing", 7: "traffic jam decreasing", 8: "traffic jam strongly decreasing" },
	2: { 0: "unavailable", 1: "multi-vehicle accident", 2: "heavy accident", 3: "accident involving a lorry", 4: "accident involving a bus", 5: "accident involving hazardous materials", 6: "accident on opposite lane", 7: "unsecured accident", 8: "assistance requested" },
	3: { 0: "unavailable", 1: "major roadworks", 2: "road marking work", 3: "slow-moving road maintenance", 4: "short-term stationary roadworks", 5: "street cleaning", 6: "winter service" },
	6: { 0: "unavailable", 1: "heavy frost on road", 2: "fuel on road", 3: "mud on road", 4: "snow on road", 5: "ice on road", 6: "black ice on road", 7: "oil on road", 8: "loose chippings", 9: "instant black ice", 10: "roads salted" },
	9: { 0: "unavailable", 1: "rockfalls", 2: "earthquake damage", 3: "sewer collapse", 4: "subsidence", 5: "snow drifts", 6: "storm damage", 7: "burst pipe", 8: "volcano eruption", 9: "falling ice" },
	10: { 0: "unavailable", 1: "shed load", 2: "parts of vehicles", 3: "parts of tyres", 4: "big objects", 5: "fallen trees", 6: "hub caps", 7: "waiting vehicles" },
	11: { 0: "unavailable", 1: "wild animals", 2: "herd of animals", 3: "small animals", 4: "large animals" },
	12: { 0: "unavailable", 1: "children on roadway", 2: "cyclist on roadway", 3: "motorcyclist on roadway" },
	14: { 0: "unavailable", 1: "wrong lane", 2: "wrong direction" },
	15: { 0: "unavailable", 1: "emergency vehicles", 2: "rescue helicopter landing", 3: "police activity ongoing", 4: "medical emergency ongoing", 5: "child abduction in progress" },
	17: { 0: "unavailable", 1: "strong winds", 2: "damaging hail", 3: "hurricane", 4: "thunderstorm", 5: "tornado", 6: "blizzard" },
	18: { 0: "unavailable", 1: "fog", 2: "smoke", 3: "heavy snowfall", 4: "heavy rain", 5: "heavy hail", 6: "low sun glare", 7: "sandstorms", 8: "swarms of insects" },
	19: { 0: "unavailable", 1: "heavy rain", 2: "heavy snowfall", 3: "soft hail" },
	26: { 0: "unavailable", 1: "maintenance vehicle", 2: "vehicles slowing to look at accident", 3: "abnormal load", 4: "abnormal wide load", 5: "convoy", 6: "snowplough", 7: "de-icing", 8: "salting vehicles" },
	27: { 0: "unavailable", 1: "sudden end of queue", 2: "queue over hill", 3: "queue around bend", 4: "queue in tunnel" },
	91: { 0: "unavailable", 1: "lack of fuel", 2: "lack of battery power", 3: "engine problem", 4: "transmission problem", 5: "engine cooling problem", 6: "braking system problem", 7: "steering problem", 8: "tyre puncture", 9: "tyre pressure problem" },
	92: { 0: "unavailable", 1: "accident without eCall triggered", 2: "accident with eCall manually triggered", 3: "accident with eCall automatically triggered", 4: "accident with eCall triggered, no cellular network access" },
	93: { 0: "unavailable", 1: "glycemia problem", 2: "heart problem" },
	94: { 0: "unavailable", 1: "human problem", 2: "vehicle breakdown", 3: "post-crash", 4: "public transport stop", 5: "carrying dangerous goods" },
	95: { 0: "unavailable", 1: "emergency vehicle approaching", 2: "prioritized vehicle approaching" },
	96: { 0: "unavailable", 1: "dangerous left turn curve", 2: "dangerous right turn curve", 3: "multiple curves, unknown first direction", 4: "multiple curves starting left", 5: "multiple curves starting right" },
	97: { 0: "unavailable", 1: "longitudinal collision risk", 2: "crossing collision risk", 3: "lateral collision risk", 4: "vulnerable road user" },
	98: { 0: "unavailable", 1: "stop sign violation", 2: "traffic light violation", 3: "turning regulation violation" },
	99: { 0: "unavailable", 1: "emergency electronic brake engaged", 2: "pre-crash system engaged", 3: "ESP engaged", 4: "ABS engaged", 5: "AEB engaged", 6: "brake warning engaged", 7: "collision risk warning engaged" },
	100: { 0: "unavailable", 1: "do not cross, abnormal situation", 2: "closed", 3: "unguarded", 4: "nominal" },
};

function subCauseCodeName(causeCode, subCauseCode) {
	if (subCauseCode === null || subCauseCode === undefined) return null;
	const table = SUB_CAUSE_CODES[causeCode];
	return (table && table[subCauseCode]) || ("sub-cause " + subCauseCode);
}

// ETSI TS 103 301 / SAE J2735 MovementPhaseState -- collapsed to the three
// colors a traffic light actually shows, for the intersection marker.
const TRAFFIC_LIGHT_COLORS = {
	"stop-And-Remain": "#e53e3e",
	"stop-Then-Proceed": "#e53e3e",
	"pre-Movement": "#ecc94b",
	"permissive-clearance": "#ecc94b",
	"protected-clearance": "#ecc94b",
	"caution-Conflicting-Traffic": "#ecc94b",
	"permissive-Movement-Allowed": "#48bb78",
	"protected-Movement-Allowed": "#48bb78",
	"dark": "#718096",
	"unavailable": "#718096",
};
const TRAFFIC_LIGHT_RANK = { "#e53e3e": 3, "#ecc94b": 2, "#48bb78": 1, "#718096": 0 };

function trafficLightColor(state) {
	return TRAFFIC_LIGHT_COLORS[state] || "#718096";
}

// TimeMark (dsrc_2_2_1.asn): tenths of a second into the current OR NEXT
// UTC hour, 0-36000; 36000 = indefinite future, 36001 = undefined/unknown
// (both return null here, not "now" or "the top of the hour"). "Current
// or next" needs disambiguating: resolve against the current hour first,
// and if that lands meaningfully in the past, it must mean the next hour
// instead (a SPAT that just arrived would never legitimately name a time
// already gone).
function timeMarkToDate(timeMark, referenceDate) {
	if (timeMark === null || timeMark === undefined || timeMark >= 36000) return null;
	const ref = referenceDate || new Date();
	const hourStart = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), ref.getUTCHours(), 0, 0, 0);
	let candidate = hourStart + timeMark * 100;
	if (candidate < ref.getTime() - 5000) candidate += 3600 * 1000;
	return new Date(candidate);
}

function countdownLabel(timeMark, referenceDate) {
	const date = timeMarkToDate(timeMark, referenceDate);
	if (!date) return null;
	const seconds = Math.round((date.getTime() - (referenceDate || new Date()).getTime()) / 1000);
	if (seconds <= 0) return "now";
	if (seconds < 60) return seconds + "s";
	return Math.round(seconds / 60) + "m";
}

// ---------------------------------------------------------------------------
// Cookie helpers -- used to remember the last map view (center/zoom/bearing/
// pitch) and filter checkbox state across reloads/visits, instead of
// re-fitting to whatever data happens to be live or resetting filters.
// ---------------------------------------------------------------------------

function readCookie(name) {
	const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
	if (!match) return null;
	try {
		return JSON.parse(decodeURIComponent(match[1]));
	} catch (e) {
		return null;
	}
}

function writeCookie(name, value) {
	const maxAgeDays = 365;
	document.cookie = name + "=" + encodeURIComponent(JSON.stringify(value)) +
		"; path=/; max-age=" + (maxAgeDays * 24 * 3600) + "; SameSite=Lax";
}

const savedView = readCookie(VIEW_COOKIE);

// Collapse/expand the whole panel on clicking its title, remembered across
// reloads the same way the map view and expired-items setting are.
const panelEl = document.getElementById("panel");
const panelToggle = document.getElementById("panel-toggle");
if (readCookie(PANEL_COLLAPSED_COOKIE) === true) {
	panelEl.classList.add("collapsed");
}
panelToggle.addEventListener("click", () => {
	panelEl.classList.toggle("collapsed");
	writeCookie(PANEL_COLLAPSED_COOKIE, panelEl.classList.contains("collapsed"));
});

// Collapse/expand the Statistics/Sensors/Layers sections independently,
// same pattern as the whole-panel toggle above, with all three remembered
// together in one cookie keyed by section id.
const savedSectionCollapsed = readCookie(SECTION_COLLAPSED_COOKIE) || {};
for (const sectionId of ["stats-section", "search-section", "devices-section", "legend", "display-section"]) {
	const sectionEl = document.getElementById(sectionId);
	const toggleEl = sectionEl.querySelector(".section-title");
	if (savedSectionCollapsed[sectionId]) {
		sectionEl.classList.add("collapsed");
	}
	toggleEl.addEventListener("click", () => {
		sectionEl.classList.toggle("collapsed");
		const state = readCookie(SECTION_COLLAPSED_COOKIE) || {};
		state[sectionId] = sectionEl.classList.contains("collapsed");
		writeCookie(SECTION_COLLAPSED_COOKIE, state);
	});
}

// ---------------------------------------------------------------------------
// Layer visibility toggles (the vehicles/rsu/denm/traffic-lights/geometry/
// trailer checkboxes in the legend). Each checkbox controls one or more
// MapLibre layer ids; state is restored from a cookie and (re)applied once
// those layers exist, from map.on("load").
// ---------------------------------------------------------------------------

const LAYER_TOGGLES = {
	"layer-vehicles": ["stations-vehicle-icons", "vehicle-courses-lines", "cam-path-history-lines"],
	"layer-rsu": ["stations-rsu-icons"],
	"layer-denm": ["hazards-icons", "denm-queue-trace-lines"],
	"layer-traffic-lights": ["traffic-lights-icons", "traffic-lights-countdown"],
	"layer-geometry": ["geometry-lines"],
	"layer-trailer": ["trailers-lines"],
	"layer-receiver-lines": ["receiver-lines-lines"],
};

const savedLayerVisibility = readCookie(LAYER_VISIBILITY_COOKIE) || {};

function applyLayerVisibility() {
	for (const [checkboxId, layerIds] of Object.entries(LAYER_TOGGLES)) {
		const checked = document.getElementById(checkboxId).checked;
		for (const layerId of layerIds) {
			if (map.getLayer(layerId)) {
				map.setLayoutProperty(layerId, "visibility", checked ? "visible" : "none");
			}
		}
	}
}

for (const checkboxId of Object.keys(LAYER_TOGGLES)) {
	const checkbox = document.getElementById(checkboxId);
	if (typeof savedLayerVisibility[checkboxId] === "boolean") {
		checkbox.checked = savedLayerVisibility[checkboxId];
	}
	checkbox.addEventListener("change", () => {
		const state = {};
		for (const id of Object.keys(LAYER_TOGGLES)) state[id] = document.getElementById(id).checked;
		writeCookie(LAYER_VISIBILITY_COOKIE, state);
		applyLayerVisibility();
	});
}

const stationSearchInput = document.getElementById("station-search-input");
const stationSearchClearButton = document.getElementById("station-search-clear");
stationSearchInput.addEventListener("input", () => {
	stationSearchText = stationSearchInput.value.trim().toLowerCase();
	applyStationSearchFilter();
});
stationSearchClearButton.addEventListener("click", () => {
	stationSearchInput.value = "";
	stationSearchText = "";
	applyStationSearchFilter();
});

// ---------------------------------------------------------------------------
// Icon generation (drawn on canvas, registered as map images -- no external
// icon assets needed). Vehicle icons point "up" (north) at rotation 0 and
// are rotated live via the layer's icon-rotate property. Shapes are sized
// to fill most of their 48x48 canvas, since icon-size scales the whole
// canvas, not just the drawn shape -- a small shape on a big transparent
// canvas renders much smaller than icon-size alone would suggest.
// ---------------------------------------------------------------------------

function makeCanvas(size) {
	const c = document.createElement("canvas");
	c.width = c.height = size;
	return c;
}

function drawVehicleIcon(shape, color) {
	const size = 48;
	const c = makeCanvas(size);
	const ctx = c.getContext("2d");
	ctx.translate(size / 2, size / 2);

	ctx.fillStyle = color;
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 3;

	function roundedArrow(len, width) {
		ctx.beginPath();
		ctx.moveTo(0, -len / 2);
		ctx.lineTo(width / 2, len / 2 - width / 3);
		ctx.lineTo(width / 4, len / 2 - width / 3);
		ctx.lineTo(width / 4, len / 2);
		ctx.lineTo(-width / 4, len / 2);
		ctx.lineTo(-width / 4, len / 2 - width / 3);
		ctx.lineTo(-width / 2, len / 2 - width / 3);
		ctx.closePath();
	}

	switch (shape) {
		case "car":
			roundedArrow(40, 26);
			ctx.fill(); ctx.stroke();
			break;
		case "bus":
		case "truck":
			roundedArrow(42, 30);
			ctx.fill(); ctx.stroke();
			break;
		case "tram":
			ctx.beginPath();
			ctx.rect(-12, -21, 24, 42);
			ctx.fill(); ctx.stroke();
			break;
		case "bike":
			ctx.beginPath();
			ctx.moveTo(0, -20);
			ctx.lineTo(13, 18);
			ctx.lineTo(0, 8);
			ctx.lineTo(-13, 18);
			ctx.closePath();
			ctx.fill(); ctx.stroke();
			break;
		case "pedestrian":
			ctx.beginPath();
			ctx.arc(0, -12, 8, 0, Math.PI * 2);
			ctx.fill();
			ctx.beginPath();
			ctx.moveTo(0, -3);
			ctx.lineTo(0, 16);
			ctx.moveTo(-11, 6); ctx.lineTo(11, 6);
			ctx.moveTo(0, 16); ctx.lineTo(-10, 27);
			ctx.moveTo(0, 16); ctx.lineTo(10, 27);
			ctx.lineWidth = 5;
			ctx.strokeStyle = color;
			ctx.stroke();
			ctx.lineWidth = 3;
			ctx.strokeStyle = "#ffffff";
			ctx.beginPath();
			ctx.arc(0, -12, 8, 0, Math.PI * 2);
			ctx.stroke();
			break;
		case "rsu":
			ctx.beginPath();
			ctx.moveTo(0, -22); ctx.lineTo(0, 14);
			ctx.moveTo(-12, -8); ctx.lineTo(12, -8);
			ctx.moveTo(-8, 3); ctx.lineTo(8, 3);
			ctx.lineWidth = 5;
			ctx.strokeStyle = color;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(0, -22, 5, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.beginPath();
			ctx.rect(-10, 14, 20, 8);
			ctx.fill();
			break;
		default:
			ctx.beginPath();
			ctx.arc(0, 0, 15, 0, Math.PI * 2);
			ctx.fill(); ctx.stroke();
	}
	return ctx.getImageData(0, 0, size, size);
}

function drawHazardIcon() {
	const size = 48;
	const c = makeCanvas(size);
	const ctx = c.getContext("2d");
	ctx.translate(size / 2, size / 2);
	ctx.beginPath();
	ctx.moveTo(0, -22);
	ctx.lineTo(21, 17);
	ctx.lineTo(-21, 17);
	ctx.closePath();
	ctx.fillStyle = "#c53030";
	ctx.strokeStyle = "#ffffff";
	ctx.lineWidth = 3;
	ctx.fill();
	ctx.stroke();
	ctx.fillStyle = "#ffffff";
	ctx.font = "bold 24px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText("!", 0, 7);
	return ctx.getImageData(0, 0, size, size);
}

function registerIcons(map) {
	const shapes = ["car", "bus", "truck", "tram", "bike", "pedestrian", "rsu", "dot"];
	const color = "#2b6cb0";
	const rsuColor = "#805ad5";
	// pixelRatio 1, not 2: these are drawn shapes, not genuine 2x-resolution
	// artwork. Declaring pixelRatio 2 told MapLibre this 48px bitmap was a
	// "retina" image for a 24px icon, halving the on-screen size for a given
	// icon-size -- combined with the shapes not filling their canvas, icons
	// were rendering at only ~10px, effectively invisible.
	for (const shape of shapes) {
		map.addImage("veh-" + shape, drawVehicleIcon(shape, shape === "rsu" ? rsuColor : color), { pixelRatio: 1 });
	}
	map.addImage("hazard", drawHazardIcon(), { pixelRatio: 1 });
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
	container: "map",
	style: "https://tiles.openfreemap.org/styles/liberty",
	center: savedView ? [savedView.lng, savedView.lat] : [10, 51],
	zoom: savedView ? savedView.zoom : 5,
	bearing: savedView ? savedView.bearing : 0,
	pitch: savedView ? savedView.pitch : 0,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-right");

// The OpenFreeMap "liberty" style references a few POI sprite icons
// (e.g. "sports_centre") that its sprite sheet doesn't actually contain --
// an upstream style/sprite mismatch, not something we control. Register a
// blank 1x1 transparent image for whatever id is missing so those specific
// POIs just render without an icon instead of spamming the console.
map.on("styleimagemissing", (e) => {
	if (map.hasImage(e.id)) return;
	map.addImage(e.id, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
});

// If we restored a saved view, respect it instead of auto-fitting to
// whatever data happens to be live on this load.
let hasFitBounds = !!savedView;

map.on("moveend", () => {
	const c = map.getCenter();
	writeCookie(VIEW_COOKIE, { lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
});

const expiredHoursSlider = document.getElementById("expired-hours-slider");
const expiredHoursLabel = document.getElementById("expired-hours-label");

function setExpiredHoursLabel() {
	const hours = parseInt(expiredHoursSlider.value, 10);
	expiredHoursLabel.textContent = hours === 0 ? "Realtime only" : `show expired up to ${hours}h old`;
}

const savedExpiredHours = readCookie(EXPIRED_HOURS_COOKIE);
if (typeof savedExpiredHours === "number" && savedExpiredHours >= 0 && savedExpiredHours <= MAX_EXPIRED_HOURS) {
	expiredHoursSlider.value = savedExpiredHours;
}
setExpiredHoursLabel();

// Update the label live while dragging, but only hit the API and persist
// the cookie once the user releases the slider ("change"), not on every
// "input" tick -- otherwise dragging across the range would fire a refresh
// per pixel.
expiredHoursSlider.addEventListener("input", setExpiredHoursLabel);
expiredHoursSlider.addEventListener("change", () => {
	writeCookie(EXPIRED_HOURS_COOKIE, parseInt(expiredHoursSlider.value, 10));
	refresh();
});

// text-font must name a font stack the style's glyphs endpoint actually
// serves (OpenFreeMap's "liberty" style only bundles Noto Sans) --
// otherwise the glyph fetch 404s and MapLibre drops the whole symbol (icon
// included), not just the label.
// Stale/expired items (only present when "show expired" is checked) render
// at reduced opacity so live items stay visually dominant.
const STATION_ICON_LAYOUT = {
	"icon-image": ["get", "icon"],
	"icon-size": 0.7,
	"icon-rotate": ["get", "heading"],
	"icon-rotation-alignment": "map",
	"icon-allow-overlap": true,
	"text-field": ["get", "macShort"],
	"text-font": ["Noto Sans Regular"],
	"text-size": 11,
	"text-offset": [0, 1.2],
	"text-anchor": "top",
	"text-allow-overlap": true,
	"text-optional": true,
};
const STATION_ICON_PAINT = {
	"icon-opacity": ["case", ["get", "isStale"], 0.4, 1],
	"text-color": "#1a202c",
	"text-halo-color": "#ffffff",
	"text-halo-width": 1.4,
	"text-opacity": ["case", ["get", "isStale"], 0.4, 1],
};
const STATIONS_CLUSTER_RADIUS = 50;
const STATIONS_CLUSTER_MAX_ZOOM = 15;

// Station search (MAC substring, case-insensitive) -- a filter on the
// vehicle/RSU layers themselves (MapLibre's "in" expression does substring
// matching directly), so it composes with clustering/re-creation with no
// extra bookkeeping. Clusters themselves are NOT filtered (the clustered
// source includes every point regardless of what the layer filters draw),
// so a cluster's count can still include non-matching stations while
// search is active -- same known simplification as the vehicle/RSU layer
// split below. The functions here only ever run from event listeners/
// map.on("load") callbacks, never during the script's own top-to-bottom
// evaluation, so declaring the variable itself here (rather than up near
// the other early page-load state) is fine.
let stationSearchText = "";

function stationLayerFilter(isRsu) {
	const base = ["all", ["!", ["has", "point_count"]], [isRsu ? "==" : "!=", ["get", "station_type"], 15]];
	if (stationSearchText) {
		base.push(["in", stationSearchText, ["downcase", ["get", "macShort"]]]);
	}
	return base;
}

function applyStationSearchFilter() {
	if (map.getLayer("stations-vehicle-icons")) map.setFilter("stations-vehicle-icons", stationLayerFilter(false));
	if (map.getLayer("stations-rsu-icons")) map.setFilter("stations-rsu-icons", stationLayerFilter(true));
}

// (Re)creates the "stations" source and its four dependent layers. Pulled
// out into its own function because MapLibre's GeoJSON `cluster` option is
// fixed at source creation -- toggling clustering on/off (the "cluster
// vehicles" checkbox) means removing and re-adding the source, not just
// flipping a paint/layout property like the other layer checkboxes.
function addStationsSourceAndLayers(cluster) {
	map.addSource("stations", cluster
		? { type: "geojson", data: emptyFC(), cluster: true, clusterMaxZoom: STATIONS_CLUSTER_MAX_ZOOM, clusterRadius: STATIONS_CLUSTER_RADIUS }
		: { type: "geojson", data: emptyFC() });

	map.addLayer({
		id: "stations-clusters",
		type: "circle",
		source: "stations",
		filter: ["has", "point_count"],
		paint: {
			"circle-color": ["step", ["get", "point_count"], "#4299e1", 10, "#2b6cb0", 50, "#1a365d"],
			"circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28],
			"circle-stroke-width": 2,
			"circle-stroke-color": "#ffffff",
		},
	});

	map.addLayer({
		id: "stations-cluster-count",
		type: "symbol",
		source: "stations",
		filter: ["has", "point_count"],
		layout: {
			"text-field": ["get", "point_count_abbreviated"],
			"text-font": ["Noto Sans Bold"],
			"text-size": 13,
		},
		paint: {
			"text-color": "#ffffff",
		},
	});

	// Split into two layers on the same source -- one per "vehicles"/"rsu"
	// legend checkbox. Clusters themselves stay mixed (a cluster can
	// contain both types); an acceptable simplification since RSUs are
	// rare next to vehicles.
	map.addLayer({
		id: "stations-vehicle-icons",
		type: "symbol",
		source: "stations",
		filter: stationLayerFilter(false),
		layout: STATION_ICON_LAYOUT,
		paint: STATION_ICON_PAINT,
	});

	map.addLayer({
		id: "stations-rsu-icons",
		type: "symbol",
		source: "stations",
		filter: stationLayerFilter(true),
		layout: STATION_ICON_LAYOUT,
		paint: STATION_ICON_PAINT,
	});
}

function setStationsClustering(enabled) {
	for (const layerId of ["stations-clusters", "stations-cluster-count", "stations-vehicle-icons", "stations-rsu-icons"]) {
		if (map.getLayer(layerId)) map.removeLayer(layerId);
	}
	if (map.getSource("stations")) map.removeSource("stations");
	addStationsSourceAndLayers(enabled);
	applyLayerVisibility();
	refresh();
}

// ---------------------------------------------------------------------------
// Focus mode -- clicking a vehicle/RSU hides every other layer and shows
// that station's full received history (its CAM trail) instead, so it's
// not lost among everything else on the map. "Show all" (the banner
// button) restores the normal view.
// ---------------------------------------------------------------------------

const FOCUS_HIDE_LAYERS = [
	"geometry-lines", "trailers-lines", "traffic-lights-icons", "traffic-lights-countdown", "heatmap-layer",
	"stations-clusters", "stations-cluster-count", "stations-vehicle-icons",
	"stations-rsu-icons", "hazards-icons", "vehicle-courses-lines", "denm-queue-trace-lines",
	"receiver-lines-lines", "cam-path-history-lines",
];

let focusedStationId = null;

function enterFocusMode(stationId) {
	focusedStationId = stationId;
	for (const layerId of FOCUS_HIDE_LAYERS) {
		if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
	}
	map.setLayoutProperty("focus-trail-line", "visibility", "visible");
	map.setLayoutProperty("focus-trail-points", "visibility", "visible");
	document.getElementById("focus-banner-text").textContent = "Showing full history for station " + stationId;
	document.getElementById("focus-banner").hidden = false;
	updateFocusTrail(true);
}

// No snapshot/restore bookkeeping needed: every hidden layer is either
// checkbox-driven (applyLayerVisibility reads the checkboxes as they
// currently stand, including any the user toggled while focused) or one of
// the two cluster layers, which have no checkbox of their own and are
// always visible outside focus mode.
function exitFocusMode() {
	focusedStationId = null;
	document.getElementById("focus-banner").hidden = true;
	map.setLayoutProperty("focus-trail-line", "visibility", "none");
	map.setLayoutProperty("focus-trail-points", "visibility", "none");
	map.getSource("focus-trail").setData(emptyFC());

	for (const layerId of ["stations-clusters", "stations-cluster-count"]) {
		if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "visible");
	}
	applyLayerVisibility();
	const heatmapCheckbox = document.getElementById("option-heatmap");
	map.setLayoutProperty("heatmap-layer", "visibility", heatmapCheckbox.checked ? "visible" : "none");
}

// Every CAM received from this station, oldest first -- literally every
// position packet it has sent, per schema.sql's own description of
// cam_messages as the append-only trail/playback table. Piggybacks on the
// same POLL_MS cadence as the main refresh() (see there) rather than its
// own timer, so the trail keeps growing live while focused.
async function updateFocusTrail(fitBounds) {
	if (focusedStationId === null) return;
	let data;
	try {
		const res = await fetch("api.php?station_id=" + focusedStationId, { cache: "no-store" });
		data = await res.json();
	} catch (err) {
		return;
	}
	if (focusedStationId === null) return; // exited while the fetch was in flight

	const points = (data.trail || []).map((p) => [parseFloat(p.longitude_deg), parseFloat(p.latitude_deg)]);
	const features = points.map((coord) => ({ type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: {} }));
	if (points.length > 1) {
		features.push({ type: "Feature", geometry: { type: "LineString", coordinates: points }, properties: {} });
	}
	map.getSource("focus-trail").setData({ type: "FeatureCollection", features });

	if (fitBounds && points.length > 0) {
		const bounds = new maplibregl.LngLatBounds();
		for (const c of points) bounds.extend(c);
		map.fitBounds(bounds, { padding: 60, maxZoom: 17, duration: 600 });
	}
}

document.getElementById("focus-banner-exit").addEventListener("click", exitFocusMode);

map.on("load", () => {
	registerIcons(map);

	// Hazards never cluster -- they're safety-critical and typically few,
	// so each one should always show individually.
	map.addSource("hazards", { type: "geojson", data: emptyFC() });
	map.addSource("denm-queue-trace", { type: "geojson", data: emptyFC() });
	map.addSource("geometry", { type: "geojson", data: emptyFC() });
	map.addSource("traffic-lights", { type: "geojson", data: emptyFC() });
	map.addSource("trailers", { type: "geojson", data: emptyFC() });
	map.addSource("receiver-lines", { type: "geojson", data: emptyFC() });
	map.addSource("vehicle-courses", { type: "geojson", data: emptyFC() });
	map.addSource("cam-path-history", { type: "geojson", data: emptyFC() });
	map.addSource("heatmap", { type: "geojson", data: emptyFC() });
	map.addSource("focus-trail", { type: "geojson", data: emptyFC() });

	map.addLayer({
		id: "geometry-lines",
		type: "line",
		source: "geometry",
		paint: {
			"line-color": "#ed8936",
			"line-width": 3,
			"line-opacity": 0.85,
		},
	});

	map.addLayer({
		id: "trailers-lines",
		type: "line",
		source: "trailers",
		paint: {
			"line-color": "#4299e1",
			"line-width": 5,
			"line-opacity": 0.8,
		},
	});

	map.addLayer({
		id: "receiver-lines-lines",
		type: "line",
		source: "receiver-lines",
		layout: { visibility: "none" },
		paint: {
			"line-color": "#a0aec0",
			"line-width": 1.5,
			"line-opacity": 0.6,
			"line-dasharray": [3, 2],
		},
	});

	// Recent course trail for currently-moving vehicles (last 5 minutes of
	// CAM positions -- see courseFeatures()). Tied to the "vehicles" legend
	// checkbox via LAYER_TOGGLES rather than getting its own, since it's
	// really just an extra visualization of the same layer.
	map.addLayer({
		id: "vehicle-courses-lines",
		type: "line",
		source: "vehicle-courses",
		paint: {
			"line-color": "#2b6cb0",
			"line-width": 2,
			"line-opacity": 0.6,
			"line-dasharray": [2, 1],
		},
	});

	// The vehicle's own self-reported pathHistory (see camPathHistoryFeatures)
	// -- distinct from vehicle-courses-lines above, which is derived
	// server-side from polled CAM positions over the last 5 minutes. This is
	// whatever trailing breadcrumb the vehicle itself chose to include in
	// its most recent CAM, which can be shorter or differently-shaped.
	map.addLayer({
		id: "cam-path-history-lines",
		type: "line",
		source: "cam-path-history",
		paint: {
			"line-color": "#805ad5",
			"line-width": 2,
			"line-opacity": 0.6,
			"line-dasharray": [1, 2],
		},
	});

	map.addLayer({
		id: "traffic-lights-icons",
		type: "circle",
		source: "traffic-lights",
		paint: {
			"circle-color": ["get", "color"],
			"circle-radius": 9,
			"circle-stroke-width": 2,
			"circle-stroke-color": "#ffffff",
		},
	});

	// Countdown to the next phase change, from the same worst-case signal
	// group driving the marker's color (see trafficLightsToFeatures) --
	// e.g. a red dot labeled "12s" means "changes (likely to green) in
	// 12s". A separate symbol layer since circle layers can't carry text.
	map.addLayer({
		id: "traffic-lights-countdown",
		type: "symbol",
		source: "traffic-lights",
		layout: {
			"text-field": ["get", "countdown"],
			"text-font": ["Noto Sans Bold"],
			"text-size": 10,
			"text-offset": [0, 1.1],
			"text-anchor": "top",
			"text-allow-overlap": true,
			"text-optional": true,
		},
		paint: {
			"text-color": "#2d3748",
			"text-halo-color": "#ffffff",
			"text-halo-width": 1.4,
		},
	});

	// Off by default (the "CAM heatmap (24h)" checkbox starts unchecked --
	// it's an opt-in extra historical query, not something to silently pull
	// on every page load) and drawn below the live station icons/clusters,
	// added right after it here.
	map.addLayer({
		id: "heatmap-layer",
		type: "heatmap",
		source: "heatmap",
		layout: { visibility: "none" },
		paint: {
			"heatmap-weight": 1,
			"heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 15, 3],
			"heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 2, 15, 20],
			"heatmap-color": [
				"interpolate", ["linear"], ["heatmap-density"],
				0, "rgba(33,102,172,0)",
				0.2, "royalblue",
				0.4, "cyan",
				0.6, "lime",
				0.8, "yellow",
				1, "red",
			],
			"heatmap-opacity": 0.7,
		},
	});

	// Focus-mode trail (see enterFocusMode): a clicked vehicle/RSU's full
	// CAM history, drawn as a line plus a dot per received position. Hidden
	// until focus mode is entered. Both layers read the same mixed
	// Point/LineString source, split by geometry type.
	map.addLayer({
		id: "focus-trail-line",
		type: "line",
		source: "focus-trail",
		filter: ["==", ["geometry-type"], "LineString"],
		layout: { visibility: "none" },
		paint: {
			"line-color": "#d53f8c",
			"line-width": 3,
			"line-opacity": 0.8,
		},
	});
	map.addLayer({
		id: "focus-trail-points",
		type: "circle",
		source: "focus-trail",
		filter: ["==", ["geometry-type"], "Point"],
		layout: { visibility: "none" },
		paint: {
			"circle-color": "#d53f8c",
			"circle-radius": 4,
			"circle-stroke-width": 1,
			"circle-stroke-color": "#ffffff",
		},
	});

	// Clustering preference persists across reloads (it's a cheap rendering
	// mode, not an extra query) -- the heatmap checkbox deliberately doesn't,
	// see above.
	const clusteringEnabled = readCookie(CLUSTERING_COOKIE);
	const initialClustering = clusteringEnabled === null ? true : clusteringEnabled;
	document.getElementById("option-clustering").checked = initialClustering;
	addStationsSourceAndLayers(initialClustering);

	document.getElementById("option-clustering").addEventListener("change", (e) => {
		writeCookie(CLUSTERING_COOKIE, e.target.checked);
		setStationsClustering(e.target.checked);
	});

	const heatmapCheckbox = document.getElementById("option-heatmap");
	heatmapCheckbox.addEventListener("change", () => {
		map.setLayoutProperty("heatmap-layer", "visibility", heatmapCheckbox.checked ? "visible" : "none");
		if (heatmapCheckbox.checked) refresh();
	});

	// Traffic-Condition/queue-type DENM extent trace -- see
	// denmQueueTraceFeatures() for the exact field this comes from and the
	// caveat on its chaining direction.
	map.addLayer({
		id: "denm-queue-trace-lines",
		type: "line",
		source: "denm-queue-trace",
		paint: {
			"line-color": "#c53030",
			"line-width": 3,
			"line-opacity": 0.6,
			"line-dasharray": [1, 1],
		},
	});

	map.addLayer({
		id: "hazards-icons",
		type: "symbol",
		source: "hazards",
		layout: {
			"icon-image": "hazard",
			"icon-size": 0.75,
			"icon-allow-overlap": true,
			"text-field": ["get", "causeLabel"],
			"text-font": ["Noto Sans Regular"],
			"text-size": 11,
			"text-offset": [0, 1.2],
			"text-anchor": "top",
			"text-allow-overlap": true,
			"text-optional": true,
		},
		paint: {
			"icon-opacity": ["case", ["get", "isExpired"], 0.4, 1],
			"text-color": "#742a2a",
			"text-halo-color": "#ffffff",
			"text-halo-width": 1.4,
			"text-opacity": ["case", ["get", "isExpired"], 0.4, 1],
		},
	});

	map.on("click", "stations-clusters", (e) => {
		const features = map.queryRenderedFeatures(e.point, { layers: ["stations-clusters"] });
		const clusterId = features[0].properties.cluster_id;
		map.getSource("stations").getClusterExpansionZoom(clusterId, (err, zoom) => {
			if (err) return;
			map.easeTo({ center: features[0].geometry.coordinates, zoom });
		});
	});

	for (const layerId of ["stations-vehicle-icons", "stations-rsu-icons", "hazards-icons", "stations-clusters", "traffic-lights-icons", "traffic-lights-countdown"]) {
		map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
		map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
	}
	for (const layerId of ["stations-vehicle-icons", "stations-rsu-icons"]) {
		map.on("click", layerId, (e) => {
			showPopup(e.features[0], e.point);
			enterFocusMode(e.features[0].properties.station_id);
		});
	}
	for (const layerId of ["hazards-icons", "traffic-lights-icons", "traffic-lights-countdown"]) {
		map.on("click", layerId, (e) => showPopup(e.features[0], e.point));
	}

	applyLayerVisibility();

	refresh();
	setInterval(refresh, POLL_MS);
	connectWebSocket();
});

// Connects to mqtt-bridge's optional live-push WebSocket (see WS_URL's own
// comment) and triggers an immediate refresh() on any message, throttled
// so a burst of several messages within a second only triggers one fetch.
// Reconnects with a capped exponential backoff on close/error -- silently
// gives up trying only in the sense that it keeps retrying forever in the
// background; polling never stops regardless, so a permanently-unreachable
// WS_URL just means "no faster than POLL_MS", not a broken page.
let wsReconnectDelayMs = 1000;
let wsLastTriggeredRefreshAt = 0;
const WS_REFRESH_THROTTLE_MS = 1000;
const WS_MAX_RECONNECT_DELAY_MS = 30000;

function connectWebSocket() {
	if (!WS_URL) return;
	let socket;
	try {
		socket = new WebSocket(WS_URL);
	} catch (err) {
		return;
	}
	socket.addEventListener("open", () => {
		wsReconnectDelayMs = 1000;
	});
	socket.addEventListener("message", () => {
		const now = Date.now();
		if (now - wsLastTriggeredRefreshAt < WS_REFRESH_THROTTLE_MS) return;
		wsLastTriggeredRefreshAt = now;
		refresh();
	});
	const scheduleReconnect = () => {
		setTimeout(connectWebSocket, wsReconnectDelayMs);
		wsReconnectDelayMs = Math.min(wsReconnectDelayMs * 2, WS_MAX_RECONNECT_DELAY_MS);
	};
	socket.addEventListener("close", scheduleReconnect);
	socket.addEventListener("error", () => socket.close());
}

function emptyFC() {
	return { type: "FeatureCollection", features: [] };
}

// ---------------------------------------------------------------------------
// Data fetch / rendering
// ---------------------------------------------------------------------------

function macShort(mac) {
	if (!mac) return "";
	return mac.toUpperCase();
}

function toBool(v) {
	return v === true || v === 1 || v === "1";
}

function stationToFeature(s, cpmByStation) {
	const info = stationTypeInfo(s.station_type);
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates: [parseFloat(s.longitude_deg), parseFloat(s.latitude_deg)] },
		properties: {
			kind: "station",
			station_id: s.station_id,
			device_id: s.device_id,
			station_type: s.station_type,
			station_type_name: info.name,
			icon: "veh-" + info.shape,
			mac: s.source_mac,
			macShort: macShort(s.source_mac),
			heading: s.heading_deg !== null ? parseFloat(s.heading_deg) : 0,
			speed_m_s: s.speed_m_s !== null ? parseFloat(s.speed_m_s) : null,
			altitude_m: s.altitude_m !== null ? parseFloat(s.altitude_m) : null,
			vehicle_length_m: s.vehicle_length_m !== null ? parseFloat(s.vehicle_length_m) : null,
			vehicle_width_m: s.vehicle_width_m !== null ? parseFloat(s.vehicle_width_m) : null,
			last_message_type: s.last_message_type,
			first_seen: s.first_seen,
			last_seen: s.last_seen,
			latitude_deg: s.latitude_deg,
			longitude_deg: s.longitude_deg,
			decoded_json: s.decoded_json,
			gn_json: s.gn_json,
			isStale: toBool(s.is_stale),
			messageCount: s.message_count !== null && s.message_count !== undefined ? parseInt(s.message_count, 10) : null,
			messagesLast5Min: s.messages_last_5min !== null && s.messages_last_5min !== undefined ? parseInt(s.messages_last_5min, 10) : null,
			trailer_json: s.trailer_json || null,
			cpm: (cpmByStation && cpmByStation.get(s.station_id)) || null,
			receiver_latitude_deg: s.receiver_latitude_deg,
			receiver_longitude_deg: s.receiver_longitude_deg,
		},
	};
}

// ---------------------------------------------------------------------------
// Geometry / traffic-light / trailer feature builders
// ---------------------------------------------------------------------------

function intersectionToLineFeatures(isec) {
	const lanes = safeParseJson(isec.lanes_json) || [];
	const features = [];
	for (const lane of lanes) {
		if (!lane.points || lane.points.length < 2) continue;
		features.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: lane.points },
			properties: {
				kind: "geometry",
				intersection_id: isec.intersection_id,
				region: isec.region,
				lane_id: lane.lane_id,
				lane_name: lane.name,
			},
		});
	}
	return features;
}

// One row per (intersection, signal group) from the API; grouped here into
// one map marker per intersection, colored by the worst-case group (red
// beats yellow beats green) since a single point can't show every group's
// state at once -- the full per-group breakdown is left for the popup.
function trafficLightsToFeatures(rows) {
	const byIntersection = new Map();
	for (const row of rows) {
		const key = row.region + "/" + row.intersection_id;
		if (!byIntersection.has(key)) {
			byIntersection.set(key, {
				intersection_id: row.intersection_id,
				region: row.region,
				name: row.intersection_name,
				latitude_deg: row.latitude_deg,
				longitude_deg: row.longitude_deg,
				groups: [],
			});
		}
		byIntersection.get(key).groups.push(row);
	}
	const features = [];
	const now = new Date();
	for (const isec of byIntersection.values()) {
		let color = "#718096";
		let worstGroup = null;
		for (const g of isec.groups) {
			const c = trafficLightColor(g.event_state);
			if (TRAFFIC_LIGHT_RANK[c] > TRAFFIC_LIGHT_RANK[color]) {
				color = c;
				worstGroup = g;
			}
		}
		// Countdown label on the marker itself: the same group driving the
		// marker's color, so a red dot labeled "12s" means "green in 12s"
		// -- recomputed once per poll (~POLL_MS), not a live per-second
		// tick, see countdownLabel().
		const countdown = worstGroup ? countdownLabel(worstGroup.likely_end_time ?? worstGroup.min_end_time, now) : null;
		features.push({
			type: "Feature",
			geometry: { type: "Point", coordinates: [parseFloat(isec.longitude_deg), parseFloat(isec.latitude_deg)] },
			properties: {
				kind: "traffic-light",
				intersection_id: isec.intersection_id,
				region: isec.region,
				name: isec.name,
				color,
				countdown: countdown || "",
				groups: JSON.stringify(isec.groups),
			},
		});
	}
	return features;
}

// Great-circle destination point -- used to place a trailer relative to
// its towing vehicle's position/heading, in metres.
function destinationPoint(lat, lon, bearingDeg, distanceM) {
	const R = 6371000;
	const bearing = (bearingDeg * Math.PI) / 180;
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const dOverR = distanceM / R;
	const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dOverR) + Math.cos(lat1) * Math.sin(dOverR) * Math.cos(bearing));
	const lon2 = lon1 + Math.atan2(
		Math.sin(bearing) * Math.sin(dOverR) * Math.cos(lat1),
		Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2)
	);
	return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

// Approximate visualization only: TrailerData carries the hitch offset and
// the trailer's own front/rear overhang (distance from its reference point
// to its extremities) but no explicit trailer length, so the body is drawn
// as a line from the hitch point spanning front+rear overhang along the
// trailer's own heading (vehicle heading adjusted by the reported hitch
// angle) -- enough to show where a trailer is and roughly how it's
// articulated, not an exact outline.
function trailersToFeatures(stations) {
	const features = [];
	for (const s of stations) {
		const trailers = safeParseJson(s.trailer_json);
		if (!trailers || !trailers.length) continue;
		const lat = parseFloat(s.latitude_deg);
		const lon = parseFloat(s.longitude_deg);
		const heading = s.heading_deg !== null && s.heading_deg !== undefined ? parseFloat(s.heading_deg) : 0;
		for (const t of trailers) {
			const reverseBearing = (heading + 180) % 360;
			const hitch = destinationPoint(lat, lon, reverseBearing, t.hitch_point_offset_m || 0);
			const trailerHeading = (heading + (t.hitch_angle_deg || 0) + 360) % 360;
			const bodyLength = (t.front_overhang_m || 0) + (t.rear_overhang_m || 0);
			if (bodyLength <= 0) continue;
			const back = destinationPoint(hitch[1], hitch[0], (trailerHeading + 180) % 360, bodyLength);
			features.push({
				type: "Feature",
				geometry: { type: "LineString", coordinates: [hitch, back] },
				properties: {
					kind: "trailer",
					station_id: s.station_id,
					trailer_width_m: t.trailer_width_m,
					hitch_angle_deg: t.hitch_angle_deg,
				},
			});
		}
	}
	return features;
}

// One line per station whose receiving device has a known position
// (devices.latitude_deg/longitude_deg -- set by hand, there's no GPS on
// the bridge hardware; NULL for most deployments until an operator fills
// it in, see schema.sql). Off by default (no checked attribute on its
// checkbox) since it's meaningless clutter until that's done.
function receiverLineFeatures(stationFeatures) {
	const features = [];
	for (const f of stationFeatures) {
		const p = f.properties;
		if (p.receiver_latitude_deg === null || p.receiver_latitude_deg === undefined) continue;
		if (p.receiver_longitude_deg === null || p.receiver_longitude_deg === undefined) continue;
		const receiver = [parseFloat(p.receiver_longitude_deg), parseFloat(p.receiver_latitude_deg)];
		features.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: [f.geometry.coordinates, receiver] },
			properties: { station_id: p.station_id, device_id: p.device_id },
		});
	}
	return features;
}

// Great-circle distance in metres -- used to tell an actually-moving
// vehicle's trail from GPS jitter on a parked one (see courseFeatures).
function haversineMeters(a, b) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(b[1] - a[1]);
	const dLon = toRad(b[0] - a[0]);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

// Recent-course trails: one polyline per vehicle that has actually moved in
// the last 5 minutes of CAM positions (data.courses -- see api.php,
// unrelated to the on-demand full-history focus-mode trail).
//
// "Moving" is judged from the trail's own total path length, not from the
// station's single latest reported speed_m_s -- that one instantaneous
// sample is unreliable (a station passing through very briefly may have
// its last-captured packet happen to read near zero, or simply never gets
// a speed reading at all if the sniffer only catches part of its transit),
// and excluded plenty of real, fast passes. A parked vehicle still sends
// CAMs with jittering GPS noise, so a small minimum path length filters
// that out without needing speed_m_s at all.
const MIN_COURSE_LENGTH_M = 8;

function courseFeatures(courses) {
	const byStation = new Map();
	for (const row of courses) {
		if (!byStation.has(row.station_id)) byStation.set(row.station_id, []);
		byStation.get(row.station_id).push([parseFloat(row.longitude_deg), parseFloat(row.latitude_deg)]);
	}
	const features = [];
	for (const [stationId, coords] of byStation) {
		if (coords.length < 2) continue;
		let length = 0;
		for (let i = 1; i < coords.length; i++) length += haversineMeters(coords[i - 1], coords[i]);
		if (length < MIN_COURSE_LENGTH_M) continue;
		features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { station_id: stationId } });
	}
	return features;
}

// DENM's `location.detectionZonesToEventPosition` (a "Traces" -- SEQUENCE
// SIZE(1..7) OF PathHistory) traces the physical extent of the hazard/
// queue behind the event position: each PathPoint is a {deltaLatitude,
// deltaLongitude} offset in the same 1e-7-degree units as absolute lat/lon
// (DeltaLatitude/DeltaLongitude in cdd_2_2_1.asn), chained -- each point
// offset from the previous one, the first offset from the event position
// itself (cdd_2_2_1.asn's own doc comment on `Path`/`PathHistory` states
// this explicitly).
//
// Sign, CONFIRMED against cdd_2_2_1.asn's DeltaLatitude/DeltaLongitude doc
// comments (not inferred): a NEGATIVE delta means south/west of the
// reference point, so each point is `reference + delta`, not `reference -
// delta` (an earlier version of this function got this backwards, which a
// real user report confirmed -- the trail rendered "all over the place").
// Cross-checked against opentrafficmap.org's own frontend (fetched
// 2026-09-10): its backend already resolves every trace in
// detectionZonesToEventPosition (not just the first) to absolute [lon,lat]
// before the frontend ever sees it, and draws one line per trace -- that
// backend is closed-source (confirmed: cits-to-json, the one public repo
// in that project, only has the ASN.1 struct definitions for these fields,
// no resolution logic), so the exact algorithm couldn't be diffed against,
// but "render every trace, not just the first" was adopted here too.
const DELTA_UNAVAILABLE = 131072;

function denmQueueTraceFeatures(hazardFeatures) {
	const features = [];
	for (const f of hazardFeatures) {
		const p = f.properties;
		const decoded = safeParseJson(p.decoded_json);
		const location = decoded && decoded.denm && decoded.denm.location;
		const traces = location && location.detectionZonesToEventPosition;
		if (!Array.isArray(traces) || !traces.length) continue;

		traces.forEach((trace, traceIndex) => {
			if (!Array.isArray(trace) || !trace.length) return;
			let lat = parseFloat(p.latitude_deg);
			let lon = parseFloat(p.longitude_deg);
			const points = [[lon, lat]];
			for (const pathPoint of trace) {
				const pos = pathPoint.pathPosition || {};
				const dLat = pos.deltaLatitude;
				const dLon = pos.deltaLongitude;
				if (dLat === undefined || dLon === undefined || dLat === DELTA_UNAVAILABLE || dLon === DELTA_UNAVAILABLE) break;
				lat += dLat / 1e7;
				lon += dLon / 1e7;
				points.push([lon, lat]);
			}
			if (points.length > 1) {
				features.push({
					type: "Feature",
					geometry: { type: "LineString", coordinates: points },
					properties: { originating_station_id: p.originating_station_id, sequence_number: p.sequence_number, trace_index: traceIndex },
				});
			}
		});
	}
	return features;
}

// CAM's own optional pathHistory (BasicVehicleContainerLowFrequency, cdd_1_3_1_1.asn)
// -- the vehicle's self-reported trailing breadcrumb, up to 40 points, each
// chained the same way as DENM's detectionZonesToEventPosition (same
// DeltaReferencePosition/PathPoint family: "the first PathPoint presents an
// offset delta position with regards to an external reference position" --
// here, the CAM's own current referencePosition -- "each other PathPoint...
// with regards to the previous PathPoint"). Sign/chaining verified against
// a real captured CAM cross-checked against an independent reference
// decoder (opentrafficmap.org): first pathHistory point deltaLatitude=1736,
// deltaLongitude=59 matched exactly on both sides.
function camPathHistoryFeatures(stationFeatures) {
	const features = [];
	for (const f of stationFeatures) {
		const p = f.properties;
		const decoded = safeParseJson(p.decoded_json);
		const params = decoded && decoded.cam && decoded.cam.camParameters;
		const lf = params && params.lowFrequencyContainer;
		if (!lf || lf.choice !== "basicVehicleContainerLowFrequency") continue;
		const path = (lf.value || {}).pathHistory;
		if (!Array.isArray(path) || !path.length) continue;

		let lat = parseFloat(p.latitude_deg);
		let lon = parseFloat(p.longitude_deg);
		const points = [[lon, lat]];
		for (const pathPoint of path) {
			const pos = pathPoint.pathPosition || {};
			const dLat = pos.deltaLatitude;
			const dLon = pos.deltaLongitude;
			if (dLat === undefined || dLon === undefined || dLat === DELTA_UNAVAILABLE || dLon === DELTA_UNAVAILABLE) break;
			lat += dLat / 1e7;
			lon += dLon / 1e7;
			points.push([lon, lat]);
		}
		if (points.length > 1) {
			features.push({
				type: "Feature",
				geometry: { type: "LineString", coordinates: points },
				properties: { station_id: p.station_id },
			});
		}
	}
	return features;
}

function hazardToFeature(h) {
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates: [parseFloat(h.longitude_deg), parseFloat(h.latitude_deg)] },
		properties: {
			kind: "hazard",
			originating_station_id: h.originating_station_id,
			sequence_number: h.sequence_number,
			device_id: h.device_id,
			station_id: h.station_id,
			mac: h.source_mac,
			causeLabel: causeCodeName(h.cause_code) || "Hazard",
			cause_code: h.cause_code,
			sub_cause_code: h.sub_cause_code,
			termination: h.termination,
			detection_time: h.detection_time,
			expires_at: h.expires_at,
			first_received_at: h.first_received_at,
			last_received_at: h.last_received_at,
			latitude_deg: h.latitude_deg,
			longitude_deg: h.longitude_deg,
			altitude_m: h.altitude_m,
			decoded_json: h.decoded_json,
			gn_json: h.gn_json,
			isExpired: toBool(h.is_expired),
		},
	};
}

// DENM deduplication: different stations reporting the SAME real-world
// event (a traffic jam three different cars all drove into, say) each get
// their own row in denm_events -- there's no way to know from the wire
// protocol alone that they're the same event, only that they probably
// are. Greedy proximity clustering: two reports merge if they share a
// cause+sub-cause and sit within HAZARD_DEDUPE_RADIUS_M of each other
// (chained -- A near B near C can end up in one cluster even if A and C
// individually exceed the radius, same tradeoff any greedy clustering
// makes). The most-recently-updated member represents the cluster on the
// map; denmQueueTraceFeatures() and per-report data still use the
// original, ungrouped hazardFeatures list -- only the marker/count is
// deduplicated, not the underlying reports.
const HAZARD_DEDUPE_RADIUS_M = 150;

function clusterHazardFeatures(hazardFeatures) {
	const clusters = [];
	for (const f of hazardFeatures) {
		const [lon, lat] = f.geometry.coordinates;
		const cluster = clusters.find((c) =>
			c.cause_code === f.properties.cause_code &&
			c.sub_cause_code === f.properties.sub_cause_code &&
			haversineMeters([lon, lat], [c.lon, c.lat]) <= HAZARD_DEDUPE_RADIUS_M
		);
		if (cluster) {
			cluster.members.push(f);
		} else {
			clusters.push({ members: [f], lon, lat, cause_code: f.properties.cause_code, sub_cause_code: f.properties.sub_cause_code });
		}
	}
	return clusters.map((cluster) => {
		if (cluster.members.length === 1) return cluster.members[0];
		const rep = cluster.members.reduce((a, b) =>
			new Date(b.properties.last_received_at) > new Date(a.properties.last_received_at) ? b : a
		);
		return {
			...rep,
			properties: {
				...rep.properties,
				sourceCount: cluster.members.length,
				sourceStationIds: cluster.members.map((m) => m.properties.originating_station_id),
			},
		};
	});
}

// Top statistics badges: vehicles and hazards always show (even at zero, so
// the panel doesn't jump around), the rest (RSUs, traffic lights,
// intersections, trailers) only appear once that layer actually has data,
// so an installation with no MAPEM/CPM traffic yet doesn't show empty badges.
function countBadge(cls, live, total, singular, plural) {
	const label = live + " " + (live === 1 ? singular : plural);
	const text = total > live ? `${label} (+${total - live} expired)` : label;
	return { cls, text };
}

function renderCounts(stationFeatures, hazardFeatures, trafficLightFeatures, intersections, trailerFeatures) {
	const vehicleFeatures = stationFeatures.filter((f) => f.properties.station_type !== 15);
	const rsuFeatures = stationFeatures.filter((f) => f.properties.station_type === 15);
	const liveVehicles = vehicleFeatures.filter((f) => !f.properties.isStale).length;
	const liveRsu = rsuFeatures.filter((f) => !f.properties.isStale).length;
	const liveHazards = hazardFeatures.filter((f) => !f.properties.isExpired).length;

	const badges = [
		countBadge("count", liveVehicles, vehicleFeatures.length, "vehicle", "vehicles"),
		countBadge("count hazard", liveHazards, hazardFeatures.length, "hazard", "hazards"),
	];
	if (rsuFeatures.length > 0) badges.push(countBadge("count rsu", liveRsu, rsuFeatures.length, "RSU", "RSUs"));
	if (trafficLightFeatures.length > 0) {
		badges.push({ cls: "count traffic-light", text: trafficLightFeatures.length + (trafficLightFeatures.length === 1 ? " traffic light" : " traffic lights") });
	}
	if (intersections.length > 0) {
		badges.push({ cls: "count geometry", text: intersections.length + (intersections.length === 1 ? " intersection" : " intersections") });
	}
	if (trailerFeatures.length > 0) {
		badges.push({ cls: "count trailer", text: trailerFeatures.length + (trailerFeatures.length === 1 ? " trailer" : " trailers") });
	}

	document.getElementById("counts").innerHTML = badges.map((b) => `<span class="${b.cls}">${escapeHtml(b.text)}</span>`).join("");
}

async function refresh() {
	let data;
	try {
		const res = await fetch(apiUrl(), { cache: "no-store" });
		data = await res.json();
	} catch (err) {
		document.getElementById("updated").textContent = "fetch failed: " + err;
		return;
	}
	if (data.error) {
		document.getElementById("updated").textContent = "error: " + data.error;
		return;
	}

	const cpmByStation = new Map((data.cpm || []).map((c) => [c.station_id, c]));
	const stationFeatures = data.stations.map((s) => stationToFeature(s, cpmByStation));
	const hazardFeatures = data.hazards.map(hazardToFeature);
	const hazardClusters = clusterHazardFeatures(hazardFeatures);
	const geometryFeatures = (data.intersections || []).flatMap(intersectionToLineFeatures);
	const trafficLightFeatures = trafficLightsToFeatures(data.traffic_lights || []);
	const trailerFeatures = trailersToFeatures(data.stations || []);
	// data.heatmap is only present when the "CAM heatmap (24h)" checkbox is
	// checked (apiUrl() only requests it then) -- [lon, lat] pairs straight
	// from cam_messages, no per-point properties needed for a density layer.
	const heatmapFeatures = (data.heatmap || []).map((p) => ({
		type: "Feature",
		geometry: { type: "Point", coordinates: p },
		properties: {},
	}));
	const courseFeaturesList = courseFeatures(data.courses || []);

	map.getSource("stations").setData({ type: "FeatureCollection", features: stationFeatures });
	map.getSource("hazards").setData({ type: "FeatureCollection", features: hazardClusters });
	map.getSource("denm-queue-trace").setData({ type: "FeatureCollection", features: denmQueueTraceFeatures(hazardFeatures) });
	map.getSource("geometry").setData({ type: "FeatureCollection", features: geometryFeatures });
	map.getSource("traffic-lights").setData({ type: "FeatureCollection", features: trafficLightFeatures });
	map.getSource("trailers").setData({ type: "FeatureCollection", features: trailerFeatures });
	map.getSource("receiver-lines").setData({ type: "FeatureCollection", features: receiverLineFeatures(stationFeatures) });
	map.getSource("heatmap").setData({ type: "FeatureCollection", features: heatmapFeatures });
	map.getSource("vehicle-courses").setData({ type: "FeatureCollection", features: courseFeaturesList });
	map.getSource("cam-path-history").setData({ type: "FeatureCollection", features: camPathHistoryFeatures(stationFeatures) });

	renderCounts(stationFeatures, hazardClusters, trafficLightFeatures, data.intersections || [], trailerFeatures);
	document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
	renderDevices(data.devices || []);

	if (!hasFitBounds && (stationFeatures.length > 0 || hazardClusters.length > 0 || trafficLightFeatures.length > 0)) {
		hasFitBounds = true;
		const bounds = new maplibregl.LngLatBounds();
		for (const f of stationFeatures) bounds.extend(f.geometry.coordinates);
		for (const f of hazardClusters) bounds.extend(f.geometry.coordinates);
		for (const f of trafficLightFeatures) bounds.extend(f.geometry.coordinates);
		map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 600 });
	}

	if (focusedStationId !== null) updateFocusTrail(false);
}

let latestDevices = [];

function renderDevices(devices) {
	latestDevices = devices;
	const el = document.getElementById("devices");
	if (devices.length === 0) {
		el.innerHTML = "";
		return;
	}
	el.innerHTML = devices.map((d) => {
		const cls = d.last_status === "online" ? "online" : "offline";
		const telemetryParts = [];
		if (d.temp_c !== null && d.temp_c !== undefined) telemetryParts.push(`${Number(d.temp_c).toFixed(1)}°C`);
		if (d.rssi_dbm !== null && d.rssi_dbm !== undefined) telemetryParts.push(`${d.rssi_dbm} dBm`);
		if (d.sniffer_rssi_dbm !== null && d.sniffer_rssi_dbm !== undefined) telemetryParts.push(`sniffer ${d.sniffer_rssi_dbm} dBm`);
		if (d.sd_found !== null && d.sd_found !== undefined) telemetryParts.push(toBool(d.sd_found) ? "SD ✓" : "SD ✗");
		if (d.stats_received_at) telemetryParts.push(`stats ${relTime(d.stats_received_at)}`);
		const telemetry = telemetryParts.length ? `<div class="device-telemetry">${telemetryParts.join(" &middot; ")}</div>` : "";
		return `<div class="device" data-device-id="${escapeHtml(d.device_id)}">
			<div class="device-head"><span class="dot ${cls}"></span>${escapeHtml(d.device_id)} (${escapeHtml(d.last_status || "?")})</div>
			${telemetry}
		</div>`;
	}).join("");
}

function messageTypeBreakdownHtml(counts) {
	if (!counts || Object.keys(counts).length === 0) return "-";
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([type, c]) => `${escapeHtml(type.toUpperCase())}: ${c}`)
		.join(", ");
}

function deviceDetailsHtml(d) {
	const rows = [
		["Device ID", escapeHtml(d.device_id)],
		["MAC", `<span class="mac">${escapeHtml(d.mac || "unknown")}</span>`],
		["Firmware", escapeHtml(d.firmware_version || "-")],
		["Hardware", escapeHtml(d.hardware_version || "-")],
		["Status", d.last_status === "online" ? `<span class="badge">online</span>` : escapeHtml(d.last_status || "-")],
		["Status since", relTime(d.last_status_at)],
		["Last seen", relTime(d.last_seen)],
		["Temperature", d.temp_c !== null && d.temp_c !== undefined ? Number(d.temp_c).toFixed(1) + "°C" : "-"],
		["RSSI", d.rssi_dbm !== null && d.rssi_dbm !== undefined ? d.rssi_dbm + " dBm" : "-"],
		["Stats reported", relTime(d.stats_received_at)],
		["Packets (24h)", d.packets_24h ?? "-"],
		["Packets (6h)", d.packets_6h ?? "-"],
		["Message types", messageTypeBreakdownHtml(d.message_type_counts)],
		["Sniffer uptime", formatDuration(d.sniffer_uptime_ms)],
		["Sniffer sent / dropped", (d.sniffer_sent_packets !== null && d.sniffer_sent_packets !== undefined)
			? `${d.sniffer_sent_packets} / ${d.sniffer_dropped_packets ?? 0}` : "-"],
		["Sniffer queue", (d.sniffer_queued !== null && d.sniffer_queued !== undefined)
			? `${d.sniffer_queued} / ${d.sniffer_queue_size}` : "-"],
		["Sniffer RSSI", d.sniffer_rssi_dbm !== null && d.sniffer_rssi_dbm !== undefined ? d.sniffer_rssi_dbm + " dBm" : "-"],
		["SD card", d.sd_found === null || d.sd_found === undefined ? "-" : (toBool(d.sd_found) ? `<span class="badge">found</span>` : "not found")],
		["SD packets written", d.sd_packets_written !== null && d.sd_packets_written !== undefined ? d.sd_packets_written : "-"],
	];
	return `<div class="cits-popup">
		<h3>${escapeHtml(d.device_id)}</h3>
		<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>
	</div>`;
}

let floatingPopupEl = null;

function closeFloatingPopup() {
	if (floatingPopupEl) {
		floatingPopupEl.remove();
		floatingPopupEl = null;
	}
}

// Every info popup (device, station, hazard, traffic light) is this same
// free-floating, draggable, absolutely-positioned box -- not a MapLibre
// Popup, which anchors itself to a map LngLat and fights manual dragging.
// The drag bar doubles as the close control; dragging never moves the
// underlying feature, it's purely a UI window position.
function showFloatingPopupAt(x, y, html) {
	closeFloatingPopup();
	floatingPopupEl = document.createElement("div");
	floatingPopupEl.className = "floating-popup";
	floatingPopupEl.innerHTML = `<div class="floating-popup-bar"><span class="floating-popup-close" title="Close">&times;</span></div>${html}`;
	floatingPopupEl.style.left = x + "px";
	floatingPopupEl.style.top = y + "px";
	document.body.appendChild(floatingPopupEl);

	const bar = floatingPopupEl.querySelector(".floating-popup-bar");
	bar.addEventListener("mousedown", (e) => {
		if (e.target.closest(".floating-popup-close")) return;
		e.preventDefault();
		const startX = e.clientX;
		const startY = e.clientY;
		const startLeft = floatingPopupEl.offsetLeft;
		const startTop = floatingPopupEl.offsetTop;
		function onMove(ev) {
			floatingPopupEl.style.left = (startLeft + ev.clientX - startX) + "px";
			floatingPopupEl.style.top = (startTop + ev.clientY - startY) + "px";
		}
		function onUp() {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		}
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	});
	bar.querySelector(".floating-popup-close").addEventListener("click", closeFloatingPopup);

	// Popup content that needs its own network fetch (station message
	// history, traffic-light stats) loads lazily -- wired up here, once,
	// right after the popup's HTML is inserted, rather than fetched
	// automatically every time a popup opens.
	const historyDetails = floatingPopupEl.querySelector(".station-history");
	if (historyDetails) {
		historyDetails.addEventListener("toggle", () => {
			if (historyDetails.open && !historyDetails.dataset.loaded) {
				historyDetails.dataset.loaded = "1";
				loadStationHistory(historyDetails, historyDetails.dataset.stationId);
			}
		});
	}
	floatingPopupEl.querySelectorAll(".tl-stats-link").forEach((link) => {
		link.addEventListener("click", (e) => {
			e.preventDefault();
			loadTlStats(link);
		});
	});

	return floatingPopupEl;
}

function showFloatingPopup(anchorEl, html) {
	const rect = anchorEl.getBoundingClientRect();
	showFloatingPopupAt(rect.left + window.scrollX, rect.bottom + window.scrollY + 6, html);
}

document.getElementById("devices").addEventListener("click", (e) => {
	const row = e.target.closest(".device");
	if (!row) return;
	const device = latestDevices.find((d) => d.device_id === row.dataset.deviceId);
	if (device) showFloatingPopup(row, deviceDetailsHtml(device));
});

// Clicking outside the popup closes it -- except clicks on a device row or
// on the map itself, both of which open/replace a popup of their own
// (via showFloatingPopupAt, called from within the same click's handler),
// so treating them as "outside" here would immediately close what was just
// opened.
document.addEventListener("click", (e) => {
	if (floatingPopupEl && !floatingPopupEl.contains(e.target) && !e.target.closest(".device") && !e.target.closest("#map")) {
		closeFloatingPopup();
	}
});

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

function escapeHtml(s) {
	if (s === null || s === undefined) return "";
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]));
}

function fmt(v, unit, digits) {
	if (v === null || v === undefined || Number.isNaN(v)) return "-";
	return (digits !== undefined ? Number(v).toFixed(digits) : v) + (unit ? " " + unit : "");
}

function formatDuration(ms) {
	if (ms === null || ms === undefined) return "-";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function relTime(iso) {
	if (!iso) return "-";
	const t = new Date(iso.replace(" ", "T") + "Z").getTime();
	if (Number.isNaN(t)) return iso;
	const secs = Math.round((Date.now() - t) / 1000);
	if (secs < 2) return "just now";
	if (secs < 60) return secs + "s ago";
	if (secs < 3600) return Math.round(secs / 60) + "m ago";
	return Math.round(secs / 3600) + "h ago";
}

function prettyJson(raw) {
	if (!raw) return null;
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch (e) {
		return raw;
	}
}

function safeParseJson(raw) {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch (e) {
		return null;
	}
}

function trailerSummary(raw) {
	const trailers = safeParseJson(raw);
	if (!trailers || !trailers.length) return "-";
	return trailers.map((t) => {
		const parts = [];
		if (t.trailer_width_m !== null && t.trailer_width_m !== undefined) parts.push(fmt(t.trailer_width_m, "m wide", 1));
		if (t.hitch_angle_deg !== null && t.hitch_angle_deg !== undefined) parts.push(fmt(t.hitch_angle_deg, "° hitch angle", 0));
		return parts.length ? parts.join(", ") : "present";
	}).join("; ");
}

// ---------------------------------------------------------------------------
// Security status (IEEE 1609.2 GeoNetworking-layer signature presence).
//
// What this can and can't tell you: mqtt-bridge's its_1609dot2.py is a
// narrow, hand-rolled COER reader that recovers the plaintext payload out
// of a signed envelope -- it deliberately never reads the `signer`
// (certificate / certificate digest) or `signature` fields at all (see
// that module's own docstring), so there is no cryptographic verification
// happening anywhere in this pipeline. This can only ever report "Missing"
// (genuinely unsecured -- Ieee1609Dot2Content chose unsecuredData) or
// "Signed" (a SignedData envelope with a certificate + signature IS
// present), never "valid" (would need to parse the signer's certificate
// and verify the ECDSA signature over ToBeSignedData) or "trusted" (would
// additionally need a real PKI root-of-trust/CTL to validate the
// certificate chain against) -- both are unimplemented, not just hidden.
// ---------------------------------------------------------------------------

function securityStatus(gnJsonRaw) {
	const gn = safeParseJson(gnJsonRaw);
	if (!gn) return null;
	if (!gn.secured) return { label: "Missing (unsecured)", title: "No IEEE 1609.2 signature envelope at all." };
	const info = gn.secured_info || {};
	if (info.error) return { label: "Secured, undecodable", title: "Envelope present but this bridge's decoder rejected it: " + info.error };
	const contentType = info.content_type;
	if (contentType === "encryptedData") {
		return { label: "Encrypted", title: "IEEE 1609.2 encryptedData -- not a plain signature, payload isn't recoverable without key material." };
	}
	if (contentType === "signedData") {
		return {
			label: "Signed (not verified)",
			title: "A certificate + signature are present, but this project never parses or cryptographically verifies them -- "
				+ "no claim is made about the signature's validity or the certificate's trust chain.",
		};
	}
	return { label: "Secured (" + (contentType || "unknown") + ")", title: "" };
}

function securityStatusRow(gnJsonRaw) {
	const s = securityStatus(gnJsonRaw);
	if (!s) return ["Security", "-"];
	return ["Security", `<span class="badge" title="${escapeHtml(s.title)}">${escapeHtml(s.label)}</span>`];
}

// ---------------------------------------------------------------------------
// CAM vehicle/RSU "additional data" (pedals, cruise control, turn signals,
// lane position, steering angle, vehicle role, RSU protected zones) --
// pulled straight out of the already-fetched decoded_json client-side, the
// same way the DENM queue trace is, rather than adding new columns for
// fields the popup only needs to display, not query on.
// ---------------------------------------------------------------------------

// BIT STRING fields decode (via mqtt-bridge's to_jsonable) as {bits, hex};
// names[i] is the named bit at ASN.1 bit position i (MSB-first per octet).
function bitStringFlags(bitObj, names) {
	if (!bitObj || typeof bitObj.hex !== "string") return null;
	const bytes = (bitObj.hex.match(/.{2}/g) || []).map((h) => parseInt(h, 16));
	const flags = {};
	names.forEach((name, i) => {
		const byte = bytes[Math.floor(i / 8)] || 0;
		flags[name] = ((byte >> (7 - (i % 8))) & 1) === 1;
	});
	return flags;
}

const ACCELERATION_CONTROL_BITS = [
	["brakePedalEngaged", "brake pedal"], ["gasPedalEngaged", "gas pedal"],
	["emergencyBrakeEngaged", "emergency brake"], ["collisionWarningEngaged", "collision warning"],
	["accEngaged", "adaptive cruise control"], ["cruiseControlEngaged", "cruise control"],
	["speedLimiterEngaged", "speed limiter"],
];
const EXTERIOR_LIGHTS_BITS = [
	["lowBeamHeadlightsOn", "low beam"], ["highBeamHeadlightsOn", "high beam"],
	["leftTurnSignalOn", "left turn signal"], ["rightTurnSignalOn", "right turn signal"],
	["daytimeRunningLightsOn", "daytime running lights"], ["reverseLightOn", "reverse light"],
	["fogLightOn", "fog light"], ["parkingLightsOn", "parking lights"],
];
const LANE_POSITION_NAMES = { "-1": "off the road", 0: "inner hard shoulder", 1: "innermost driving lane", 2: "2nd lane from inside", 14: "outer hard shoulder" };
const VEHICLE_ROLES = {
	0: "default", 1: "public transport", 2: "special transport", 3: "dangerous goods",
	4: "road work", 5: "rescue", 6: "emergency", 7: "safety car", 8: "agriculture",
	9: "commercial", 10: "military", 11: "road operator", 12: "taxi",
};

function activeFlagsLabel(bitObj, bitNames) {
	const flags = bitStringFlags(bitObj, bitNames.map(([name]) => name));
	if (!flags) return null;
	const active = bitNames.filter(([name]) => flags[name]).map(([, label]) => label);
	return active.length ? active.join(", ") : "none";
}

// Vehicle-specific CAM extras, plus RSU protected zones -- returns extra
// [label, value] rows to append to a station popup's table, empty for
// anything else (RSU CAMs, or a station whose last message wasn't a CAM).
function camExtraRows(decodedJson) {
	const decoded = safeParseJson(decodedJson);
	const params = decoded && decoded.cam && decoded.cam.camParameters;
	if (!params) return [];

	const rows = [];
	const hf = params.highFrequencyContainer;
	if (hf && hf.choice === "basicVehicleContainerHighFrequency") {
		const v = hf.value || {};
		const pedals = activeFlagsLabel(v.accelerationControl, ACCELERATION_CONTROL_BITS);
		if (pedals !== null) rows.push(["Pedals / controls", pedals]);
		if (v.lanePosition !== undefined && v.lanePosition !== null) {
			rows.push(["Lane position", LANE_POSITION_NAMES[v.lanePosition] || ("lane " + v.lanePosition)]);
		}
		const steer = v.steeringWheelAngle && v.steeringWheelAngle.steeringWheelAngleValue;
		if (steer !== undefined && steer !== null && steer !== 512) rows.push(["Steering wheel", fmt(steer * 1.5, "°", 1)]);
	} else if (hf && hf.choice === "rsuContainerHighFrequency") {
		const zones = (hf.value || {}).protectedCommunicationZonesRSU || [];
		if (zones.length) rows.push(["Protected zones", zones.length + (zones.length === 1 ? " zone" : " zones")]);
	}

	const lf = params.lowFrequencyContainer;
	if (lf && lf.choice === "basicVehicleContainerLowFrequency") {
		const v = lf.value || {};
		const lights = activeFlagsLabel(v.exteriorLights, EXTERIOR_LIGHTS_BITS);
		if (lights !== null) rows.push(["Lights / signals", lights]);
		if (v.vehicleRole !== undefined && v.vehicleRole !== null) {
			rows.push(["Vehicle role", VEHICLE_ROLES[v.vehicleRole] || ("role " + v.vehicleRole)]);
		}
		if (Array.isArray(v.pathHistory) && v.pathHistory.length) {
			rows.push(["Path history", v.pathHistory.length + (v.pathHistory.length === 1 ? " point" : " points")]);
		}
	}
	return rows;
}

// CPM perceived-object bearing, from the schema's own East-positive x_m /
// North-positive y_m convention (cpm_perceived_objects in schema.sql).
// 0° = north (same reporting station's y-axis), clockwise.
function bearingDegrees(x, y) {
	let deg = (Math.atan2(x, y) * 180) / Math.PI;
	if (deg < 0) deg += 360;
	return deg;
}

// CPM detail for the popup: variant/origin plus every perceived object
// from the sender's latest CPM (p.cpm, from api.php's `cpm` query -- null
// for a station that hasn't sent one). Objects are relative to the sender
// (x_m/y_m, not absolute lon/lat -- resolving that needs the sender's
// heading and an unverified rotation convention the ingester deliberately
// didn't guess at), so they're shown as distance/bearing rather than
// plotted as their own markers.
function cpmExtraRows(cpm) {
	if (!cpm) return [];
	const rows = [];
	if (cpm.asn1_variant) rows.push(["CPM variant", escapeHtml(cpm.asn1_variant)]);
	if (cpm.origin_kind) rows.push(["CPM origin", escapeHtml(cpm.origin_kind)]);
	const objects = cpm.objects || [];
	if (objects.length) {
		const lines = objects.map((o) => {
			const x = parseFloat(o.x_m);
			const y = parseFloat(o.y_m);
			const hasPos = Number.isFinite(x) && Number.isFinite(y);
			const parts = [escapeHtml(o.classification || ("object " + o.object_id))];
			if (hasPos) {
				const dist = Math.sqrt(x * x + y * y);
				parts.push(`${dist.toFixed(1)} m @ ${bearingDegrees(x, y).toFixed(0)}°`);
			}
			if (o.object_age_ms !== null && o.object_age_ms !== undefined) parts.push(`tracked ${o.object_age_ms} ms`);
			return parts.join(", ");
		});
		rows.push(["Perceived objects", `${objects.length}<br><span class="cpm-objects">${lines.join("<br>")}</span>`]);
	}
	return rows;
}

function stationPopupHtml(p) {
	const rows = [
		["Station ID", p.station_id],
		["MAC", `<span class="mac">${escapeHtml(p.mac || "unknown")}</span>`],
		["Type", `<span class="badge">${escapeHtml(p.station_type_name)}</span>`],
		["Message", (p.last_message_type || "").toUpperCase()],
		["Speed", p.speed_m_s !== null ? fmt(p.speed_m_s * 3.6, "km/h", 1) + ` (${fmt(p.speed_m_s, "m/s", 1)})` : "-"],
		["Heading", p.heading !== null ? fmt(p.heading, "°", 1) : "-"],
		["Altitude", p.altitude_m !== null ? fmt(p.altitude_m, "m", 1) : "-"],
		["Size", (p.vehicle_length_m || p.vehicle_width_m) ? `${fmt(p.vehicle_length_m, "m", 1)} x ${fmt(p.vehicle_width_m, "m", 1)}` : "-"],
		["Position", `${p.latitude_deg}, ${p.longitude_deg}`],
		["Trailer", trailerSummary(p.trailer_json)],
		securityStatusRow(p.gn_json),
		...camExtraRows(p.decoded_json),
		...cpmExtraRows(p.cpm),
		["Device", escapeHtml(p.device_id)],
		["First seen", relTime(p.first_seen)],
		["Last seen", relTime(p.last_seen)],
		["Messages received", p.messageCount !== null ? p.messageCount : "-"],
		["Reception rate", p.messagesLast5Min !== null ? (p.messagesLast5Min / 5).toFixed(1) + "/min" : "-"],
	];
	const json = prettyJson(p.decoded_json);
	const staleTag = p.isStale ? ` <span class="expired-tag">(expired)</span>` : "";
	return `<div class="cits-popup">
		<h3>${escapeHtml(p.station_type_name)} &middot; ${escapeHtml(p.mac || "station " + p.station_id)}${staleTag}</h3>
		<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>
		<details class="station-history" data-station-id="${escapeHtml(String(p.station_id))}">
			<summary>Message history</summary>
			<div class="station-history-body">loading&hellip;</div>
		</details>
		${json ? `<details><summary>Raw decoded message</summary><pre>${escapeHtml(json)}</pre></details>` : ""}
	</div>`;
}

// Lazy-loaded (see showFloatingPopupAt's wiring of the ".station-history"
// <details> toggle event) rather than fetched every time a popup opens --
// it's every its_messages row for the station, any type, could be a lot.
async function loadStationHistory(detailsEl, stationId) {
	const body = detailsEl.querySelector(".station-history-body");
	let data;
	try {
		const res = await fetch("api.php?station_id=" + encodeURIComponent(stationId), { cache: "no-store" });
		data = await res.json();
	} catch (err) {
		body.textContent = "Failed to load history.";
		return;
	}
	const rows = data.station_history || [];
	if (!rows.length) {
		body.textContent = "No message history found.";
		return;
	}
	body.innerHTML = rows.map((r) => {
		const errTag = r.decode_error ? ` <span class="expired-tag" title="${escapeHtml(r.decode_error)}">(decode error)</span>` : "";
		return `<div>${escapeHtml(relTime(r.received_at))} &middot; ${escapeHtml((r.message_type || "?").toUpperCase())}${errTag}</div>`;
	}).join("");
}

function hazardPopupHtml(p) {
	const rows = [
		["Cause", escapeHtml(p.causeLabel)],
		["Sub-cause", escapeHtml(subCauseCodeName(p.cause_code, p.sub_cause_code) || "-")],
	];
	if (p.sourceCount > 1) {
		rows.push(["Sources", `${p.sourceCount} stations reporting nearby (${escapeHtml(p.sourceStationIds.join(", "))}) -- shown as one marker, likely the same event`]);
	}
	rows.push(
		["Originating station", p.originating_station_id],
		["Sequence #", p.sequence_number],
		["MAC", `<span class="mac">${escapeHtml(p.mac || "unknown")}</span>`],
		["Status", p.termination ? `terminated (${escapeHtml(p.termination)})` : (p.isExpired ? "expired" : `<span class="badge">active</span>`)],
		["Position", `${p.latitude_deg}, ${p.longitude_deg}`],
		["Altitude", p.altitude_m !== null ? fmt(p.altitude_m, "m", 1) : "-"],
		securityStatusRow(p.gn_json),
		["Device", escapeHtml(p.device_id)],
		["First received", relTime(p.first_received_at)],
		["Last received", relTime(p.last_received_at)],
		["Expires", p.expires_at ? relTime(p.expires_at).replace("ago", "") + (new Date(p.expires_at) > new Date() ? " left" : " (expired)") : "-"],
	);
	const json = prettyJson(p.decoded_json);
	const expiredTag = p.isExpired ? ` <span class="expired-tag">(expired)</span>` : "";
	return `<div class="cits-popup">
		<h3>&#9888; ${escapeHtml(p.causeLabel)}${expiredTag}</h3>
		<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>
		${json ? `<details><summary>Raw decoded message</summary><pre>${escapeHtml(json)}</pre></details>` : ""}
	</div>`;
}

function trafficLightPopupHtml(p) {
	const groups = safeParseJson(p.groups) || [];
	const now = new Date();
	const rows = groups.map((g) => {
		const label = (g.event_state || "unknown").replace(/-/g, " ");
		const sec = securityStatus(g.gn_json);
		const secBadge = sec ? ` <span class="badge" title="${escapeHtml(sec.title)}">${escapeHtml(sec.label)}</span>` : "";
		const countdown = countdownLabel(g.likely_end_time ?? g.min_end_time, now);
		const countdownText = countdown ? ` <span class="expired-tag">(changes in ${escapeHtml(countdown)})</span>` : "";
		const statsKey = `${p.region}/${p.intersection_id}/${g.signal_group}`;
		const statsLink = ` <a href="#" class="tl-stats-link" data-tl-stats="${escapeHtml(statsKey)}">stats</a>`;
		return [`Group ${escapeHtml(String(g.signal_group))}`, escapeHtml(label) + secBadge + countdownText + statsLink];
	});
	return `<div class="cits-popup">
		<h3>&#128678; ${escapeHtml(p.name || "Intersection " + p.intersection_id)}</h3>
		<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>
	</div>`;
}

// Fetched on click (the "stats" link per signal group), not automatically --
// see api.php's tl_stats comment for why it's a heavier query than the
// normal poll. Durations are pre-summed server-side; this just turns them
// into percentages of the window.
async function loadTlStats(link) {
	const key = link.dataset.tlStats;
	link.textContent = "loading…";
	let data;
	try {
		const res = await fetch("api.php?tl_stats=" + encodeURIComponent(key), { cache: "no-store" });
		data = await res.json();
	} catch (err) {
		link.textContent = "failed to load";
		return;
	}
	const stats = data.tl_stats;
	const totals = (stats && stats.totals_seconds) || {};
	const sum = Object.values(totals).reduce((a, b) => a + b, 0);
	if (!sum) {
		link.outerHTML = `<span class="tl-stats-result">no history yet</span>`;
		return;
	}
	const parts = Object.entries(totals)
		.sort((a, b) => b[1] - a[1])
		.map(([state, secs]) => `${escapeHtml((state || "unknown").replace(/-/g, " "))}: ${Math.round((secs / sum) * 100)}%`);
	link.outerHTML = `<span class="tl-stats-result">${parts.join(", ")} (last ${stats.window_hours}h)</span>`;
}

function showPopup(feature, point) {
	const p = feature.properties;
	let html;
	if (p.kind === "hazard") html = hazardPopupHtml(p);
	else if (p.kind === "traffic-light") html = trafficLightPopupHtml(p);
	else html = stationPopupHtml(p);
	const mapRect = map.getContainer().getBoundingClientRect();
	showFloatingPopupAt(mapRect.left + window.scrollX + point.x + 14, mapRect.top + window.scrollY + point.y - 10, html);
}
