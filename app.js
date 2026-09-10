"use strict";

const STALE_SECONDS = 120;
const POLL_MS = 4000;
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
	91: "Collision Risk",
	92: "Signal Violation",
	93: "Dangerous Situation",
	94: "Railway Level Crossing",
	95: "Public Transport Vehicle Approaching",
};

function causeCodeName(c) {
	if (c === null || c === undefined) return null;
	return CAUSE_CODES[c] || ("Cause code " + c);
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
for (const sectionId of ["stats-section", "devices-section", "legend", "display-section"]) {
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
	"layer-vehicles": ["stations-vehicle-icons"],
	"layer-rsu": ["stations-rsu-icons"],
	"layer-denm": ["hazards-icons"],
	"layer-traffic-lights": ["traffic-lights-icons"],
	"layer-geometry": ["geometry-lines"],
	"layer-trailer": ["trailers-lines"],
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
let popup = null;

map.on("moveend", () => {
	const c = map.getCenter();
	writeCookie(VIEW_COOKIE, { lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
});

const expiredHoursSlider = document.getElementById("expired-hours-slider");
const expiredHoursLabel = document.getElementById("expired-hours-label");

function setExpiredHoursLabel() {
	expiredHoursLabel.textContent = expiredHoursSlider.value + "h";
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
		filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "station_type"], 15]],
		layout: STATION_ICON_LAYOUT,
		paint: STATION_ICON_PAINT,
	});

	map.addLayer({
		id: "stations-rsu-icons",
		type: "symbol",
		source: "stations",
		filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "station_type"], 15]],
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

map.on("load", () => {
	registerIcons(map);

	// Hazards never cluster -- they're safety-critical and typically few,
	// so each one should always show individually.
	map.addSource("hazards", { type: "geojson", data: emptyFC() });
	map.addSource("geometry", { type: "geojson", data: emptyFC() });
	map.addSource("traffic-lights", { type: "geojson", data: emptyFC() });
	map.addSource("trailers", { type: "geojson", data: emptyFC() });
	map.addSource("heatmap", { type: "geojson", data: emptyFC() });

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

	for (const layerId of ["stations-vehicle-icons", "stations-rsu-icons", "hazards-icons", "stations-clusters", "traffic-lights-icons"]) {
		map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
		map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
	}
	for (const layerId of ["stations-vehicle-icons", "stations-rsu-icons", "hazards-icons", "traffic-lights-icons"]) {
		map.on("click", layerId, (e) => showPopup(e.features[0]));
	}

	applyLayerVisibility();

	refresh();
	setInterval(refresh, POLL_MS);
});

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

function stationToFeature(s) {
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
			isStale: toBool(s.is_stale),
			messageCount: s.message_count !== null && s.message_count !== undefined ? parseInt(s.message_count, 10) : null,
			messagesLast5Min: s.messages_last_5min !== null && s.messages_last_5min !== undefined ? parseInt(s.messages_last_5min, 10) : null,
			trailer_json: s.trailer_json || null,
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
	for (const isec of byIntersection.values()) {
		let color = "#718096";
		for (const g of isec.groups) {
			const c = trafficLightColor(g.event_state);
			if (TRAFFIC_LIGHT_RANK[c] > TRAFFIC_LIGHT_RANK[color]) color = c;
		}
		features.push({
			type: "Feature",
			geometry: { type: "Point", coordinates: [parseFloat(isec.longitude_deg), parseFloat(isec.latitude_deg)] },
			properties: {
				kind: "traffic-light",
				intersection_id: isec.intersection_id,
				region: isec.region,
				name: isec.name,
				color,
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
			isExpired: toBool(h.is_expired),
		},
	};
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

	const stationFeatures = data.stations.map(stationToFeature);
	const hazardFeatures = data.hazards.map(hazardToFeature);
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

	map.getSource("stations").setData({ type: "FeatureCollection", features: stationFeatures });
	map.getSource("hazards").setData({ type: "FeatureCollection", features: hazardFeatures });
	map.getSource("geometry").setData({ type: "FeatureCollection", features: geometryFeatures });
	map.getSource("traffic-lights").setData({ type: "FeatureCollection", features: trafficLightFeatures });
	map.getSource("trailers").setData({ type: "FeatureCollection", features: trailerFeatures });
	map.getSource("heatmap").setData({ type: "FeatureCollection", features: heatmapFeatures });

	renderCounts(stationFeatures, hazardFeatures, trafficLightFeatures, data.intersections || [], trailerFeatures);
	document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
	renderDevices(data.devices || []);

	if (!hasFitBounds && (stationFeatures.length > 0 || hazardFeatures.length > 0 || trafficLightFeatures.length > 0)) {
		hasFitBounds = true;
		const bounds = new maplibregl.LngLatBounds();
		for (const f of stationFeatures) bounds.extend(f.geometry.coordinates);
		for (const f of hazardFeatures) bounds.extend(f.geometry.coordinates);
		for (const f of trafficLightFeatures) bounds.extend(f.geometry.coordinates);
		map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 600 });
	}
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

function showFloatingPopup(anchorEl, html) {
	closeFloatingPopup();
	const rect = anchorEl.getBoundingClientRect();
	floatingPopupEl = document.createElement("div");
	floatingPopupEl.className = "floating-popup";
	floatingPopupEl.innerHTML = html;
	floatingPopupEl.style.top = (rect.bottom + window.scrollY + 6) + "px";
	floatingPopupEl.style.left = (rect.left + window.scrollX) + "px";
	document.body.appendChild(floatingPopupEl);
}

document.getElementById("devices").addEventListener("click", (e) => {
	const row = e.target.closest(".device");
	if (!row) return;
	const device = latestDevices.find((d) => d.device_id === row.dataset.deviceId);
	if (device) showFloatingPopup(row, deviceDetailsHtml(device));
});

document.addEventListener("click", (e) => {
	if (floatingPopupEl && !floatingPopupEl.contains(e.target) && !e.target.closest(".device")) {
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
		${json ? `<details><summary>Raw decoded message</summary><pre>${escapeHtml(json)}</pre></details>` : ""}
	</div>`;
}

function hazardPopupHtml(p) {
	const rows = [
		["Cause", escapeHtml(p.causeLabel)],
		["Sub-cause", p.sub_cause_code !== null ? p.sub_cause_code : "-"],
		["Originating station", p.originating_station_id],
		["Sequence #", p.sequence_number],
		["MAC", `<span class="mac">${escapeHtml(p.mac || "unknown")}</span>`],
		["Status", p.termination ? `terminated (${escapeHtml(p.termination)})` : (p.isExpired ? "expired" : `<span class="badge">active</span>`)],
		["Position", `${p.latitude_deg}, ${p.longitude_deg}`],
		["Altitude", p.altitude_m !== null ? fmt(p.altitude_m, "m", 1) : "-"],
		["Device", escapeHtml(p.device_id)],
		["First received", relTime(p.first_received_at)],
		["Last received", relTime(p.last_received_at)],
		["Expires", p.expires_at ? relTime(p.expires_at).replace("ago", "") + (new Date(p.expires_at) > new Date() ? " left" : " (expired)") : "-"],
	];
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
	const rows = groups.map((g) => {
		const label = (g.event_state || "unknown").replace(/-/g, " ");
		return [`Group ${escapeHtml(String(g.signal_group))}`, escapeHtml(label)];
	});
	return `<div class="cits-popup">
		<h3>&#128678; ${escapeHtml(p.name || "Intersection " + p.intersection_id)}</h3>
		<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>
	</div>`;
}

function showPopup(feature) {
	if (popup) popup.remove();
	const p = feature.properties;
	let html;
	if (p.kind === "hazard") html = hazardPopupHtml(p);
	else if (p.kind === "traffic-light") html = trafficLightPopupHtml(p);
	else html = stationPopupHtml(p);
	popup = new maplibregl.Popup({ maxWidth: "320px" })
		.setLngLat(feature.geometry.coordinates)
		.setHTML(html)
		.addTo(map);
}
