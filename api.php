<?php
// Read-only JSON API for the C-ITS map viewer. Queries the its_bridge MySQL
// database populated by mqtt-bridge/mqtt_to_mysql.py (see ../../../../tmp
// esp32-c3-bridge/mqtt-bridge/schema.sql for the table layout this depends on).
error_reporting(E_ALL);
// Use legacy mysqli error handling (return false on query error) instead of
// PHP 8.1+'s default of throwing exceptions -- the tables this queries are
// created separately by schema.sql and may not exist yet on a fresh setup,
// which should degrade to an empty response, not a 500.
mysqli_report(MYSQLI_REPORT_OFF);
header('Content-Type: application/json; charset=utf-8');

// The its_bridge MySQL user is only granted on host '%'. MySQL treats both
// 'localhost' and 127.0.0.1 loopback connections as the special 'localhost'
// identity for grant matching (which '%' does not cover), so we connect via
// the box's real LAN address instead to land on the '%' grant.
// Credentials come from .env (see env.php / .env.example) rather than being
// hardcoded here.
require __DIR__ . '/env.php';
$l = mysqli_connect($DB_HOST, $DB_USER, $DB_PASSWORD, $DB_NAME);
if (!$l) {
	http_response_code(500);
	echo json_encode(['error' => 'db connect failed: ' . mysqli_connect_error()]);
	exit;
}

// How stale a station's last-known position may be before it counts as
// expired (tagged is_stale/is_expired in the response rather than dropped --
// both tables only ever hold one row per station/hazard, so returning
// everything within the window is cheap).
$staleSeconds = isset($_GET['stale']) ? max(5, (int)$_GET['stale']) : 120;
// How far back to include already-expired/inactive stations and hazards,
// picked via a slider in the UI. 0 = none (only live items, same as the
// old "show expired" checkbox unchecked); capped at 7 days.
$expiredHours = isset($_GET['expired_hours']) ? min(7 * 24, max(0, (int)$_GET['expired_hours'])) : 0;
$windowSeconds = $expiredHours > 0 ? $expiredHours * 3600 : $staleSeconds;

function fetchAll($res): array {
	$rows = [];
	if (!$res) return $rows;
	while ($row = $res->fetch_assoc()) {
		$rows[] = $row;
	}
	return $rows;
}

$schemaMissing = false;

// Latest position per known station, left-joined against the most recent
// its_messages row for that station to pick up the 802.11 source MAC and
// the full decoded facility-layer JSON (for the popup's raw-detail view),
// plus a per-station message count/recent rate (used in that station's own
// popup, not a global box -- stats should be scoped to the station you
// clicked, not lumped across every connected sniffer).
// Freshness is compared with UTC_TIMESTAMP(), not NOW(): both this app and
// mqtt_to_mysql.py write UTC-naive timestamps, but NOW() returns this
// server's local (CEST) time -- comparing against it would make every row
// look ~2 hours stale.
$stations = [];
$sql = "SELECT s.station_id, s.device_id, s.station_type, s.last_message_type,
               s.latitude_deg, s.longitude_deg, s.altitude_m,
               s.heading_deg, s.speed_m_s, s.vehicle_length_m, s.vehicle_width_m,
               s.trailer_json, s.first_seen, s.last_seen,
               (s.last_seen <= (UTC_TIMESTAMP() - INTERVAL ? SECOND)) AS is_stale,
               im.source_mac, im.message_type AS latest_message_type,
               im.protocol_version, im.decoded_json,
               (SELECT COUNT(*) FROM cam_messages cm WHERE cm.station_id = s.station_id) AS message_count,
               (SELECT COUNT(*) FROM cam_messages cm WHERE cm.station_id = s.station_id
                   AND cm.received_at > (UTC_TIMESTAMP() - INTERVAL 5 MINUTE)) AS messages_last_5min
        FROM stations s
        LEFT JOIN its_messages im ON im.id = (
            SELECT im2.id FROM its_messages im2
            WHERE im2.station_id = s.station_id
            ORDER BY im2.received_at DESC
            LIMIT 1
        )
        WHERE s.last_seen > (UTC_TIMESTAMP() - INTERVAL ? SECOND)";
if ($stmt = $l->prepare($sql)) {
	$stmt->bind_param('ii', $staleSeconds, $windowSeconds);
	$stmt->execute();
	$stations = fetchAll($stmt->get_result());
	$stmt->close();
} else {
	$schemaMissing = true;
}

// DENM hazard events -- currently-active ones always included, plus
// already-terminated/expired ones whose last_received_at falls within the
// expired-items window (none, when $expiredHours is 0).
$hazards = [];
$sql = "SELECT d.originating_station_id, d.sequence_number, d.device_id, d.station_id,
               d.station_type, d.cause_code, d.sub_cause_code, d.termination, d.is_active,
               d.detection_time, d.reference_time, d.validity_duration_s, d.expires_at,
               d.latitude_deg, d.longitude_deg, d.altitude_m, d.decoded_json,
               d.first_received_at, d.last_received_at,
               (NOT d.is_active OR (d.expires_at IS NOT NULL AND d.expires_at <= UTC_TIMESTAMP())) AS is_expired,
               im.source_mac
        FROM denm_events d
        LEFT JOIN its_messages im ON im.id = (
            SELECT im2.id FROM its_messages im2
            WHERE im2.station_id = d.station_id
            ORDER BY im2.received_at DESC
            LIMIT 1
        )
        WHERE (d.is_active AND (d.expires_at IS NULL OR d.expires_at > UTC_TIMESTAMP()))"
        . ($expiredHours > 0 ? " OR d.last_received_at > (UTC_TIMESTAMP() - INTERVAL ? HOUR)" : "");
if ($stmt = $l->prepare($sql)) {
	if ($expiredHours > 0) {
		$stmt->bind_param('i', $expiredHours);
	}
	$stmt->execute();
	$hazards = fetchAll($stmt->get_result());
	$stmt->close();
} else {
	$schemaMissing = true;
}

// CAM heatmap points, last 24h -- only queried when explicitly requested
// (the "CAM heatmap" checkbox is unchecked by default) since cam_messages
// is an append-only history, not the small latest-position `stations`
// table, and can be large. Capped with a LIMIT for the same reason; plain
// [lon, lat] pairs rather than objects to keep the payload small.
$heatmap = [];
if (isset($_GET['heatmap'])) {
	$res = $l->query("SELECT longitude_deg, latitude_deg FROM cam_messages
	                   WHERE received_at > (UTC_TIMESTAMP() - INTERVAL 24 HOUR)
	                   ORDER BY id DESC LIMIT 20000");
	if ($res === false) {
		$schemaMissing = true;
	} else {
		while ($row = $res->fetch_row()) {
			$heatmap[] = [(float)$row[0], (float)$row[1]];
		}
	}
}

// Intersection / lane geometry from MAPEM (the "geometry" layer). These
// barely ever change once an RSU has broadcast them, so unlike
// stations/hazards this isn't gated by $staleSeconds/$windowSeconds -- every
// known intersection is returned.
$intersections = [];
$res = $l->query("SELECT intersection_id, region, name, revision,
                          latitude_deg, longitude_deg, altitude_m, lanes_json,
                          first_received_at, last_received_at
                   FROM intersections");
if ($res === false) {
	$schemaMissing = true;
} else {
	$intersections = fetchAll($res);
}

// Current signal state per (intersection, signal group), positioned via the
// matching `intersections` row (MAPEM) -- a signal group with no known
// intersection geometry yet simply doesn't appear here (inner join).
$trafficLights = [];
$sql = "SELECT t.intersection_id, t.region, t.signal_group, t.event_state,
               t.min_end_time, t.max_end_time, t.likely_end_time,
               t.device_id, t.station_id, t.last_received_at,
               i.name AS intersection_name, i.latitude_deg, i.longitude_deg
        FROM traffic_light_states t
        JOIN intersections i ON i.region = t.region AND i.intersection_id = t.intersection_id
        WHERE t.last_received_at > (UTC_TIMESTAMP() - INTERVAL ? SECOND)";
if ($stmt = $l->prepare($sql)) {
	$stmt->bind_param('i', $staleSeconds);
	$stmt->execute();
	$trafficLights = fetchAll($stmt->get_result());
	$stmt->close();
} else {
	$schemaMissing = true;
}

// Bridge device bookkeeping, left-joined against each device's most recent
// device_stats row (temp/rssi from the bridge's periodic "stats" MQTT
// topic) so the panel can show per-bridge telemetry, not just online/offline.
// Also pulls raw packet volume over two windows and an all-time breakdown
// of decoded message types, for the device detail popup.
$devices = [];
$res = $l->query("SELECT d.device_id, d.mac, d.firmware_version, d.hardware_version,
                          d.last_status, d.last_status_at, d.last_seen,
                          ds.temp_c, ds.rssi_dbm, ds.received_at AS stats_received_at,
                          ds.sniffer_uptime_ms, ds.sniffer_sent_packets, ds.sniffer_dropped_packets,
                          ds.sniffer_queued, ds.sniffer_queue_size, ds.sniffer_rssi_dbm, ds.sniffer_age_ms,
                          (SELECT COUNT(*) FROM packets p WHERE p.device_id = d.device_id
                              AND p.received_at > (UTC_TIMESTAMP() - INTERVAL 24 HOUR)) AS packets_24h,
                          (SELECT COUNT(*) FROM packets p WHERE p.device_id = d.device_id
                              AND p.received_at > (UTC_TIMESTAMP() - INTERVAL 6 HOUR)) AS packets_6h
                   FROM devices d
                   LEFT JOIN device_stats ds ON ds.id = (
                       SELECT ds2.id FROM device_stats ds2
                       WHERE ds2.device_id = d.device_id
                       ORDER BY ds2.received_at DESC
                       LIMIT 1
                   )
                   ORDER BY d.device_id");
if ($res === false) {
	$schemaMissing = true;
} else {
	$devices = fetchAll($res);

	// All-time message-type breakdown per device. its_messages is the full
	// decode log (grows unbounded) so this GROUP BY over the whole table
	// isn't free, but it's a small number of distinct (device_id,
	// message_type) groups and this project's scale is modest.
	$typeCounts = [];
	$res2 = $l->query("SELECT device_id, message_type, COUNT(*) AS c FROM its_messages GROUP BY device_id, message_type");
	if ($res2 !== false) {
		while ($row = $res2->fetch_assoc()) {
			$type = $row['message_type'] ?? 'unknown';
			$typeCounts[$row['device_id']][$type] = (int)$row['c'];
		}
	}
	foreach ($devices as &$dev) {
		$dev['message_type_counts'] = $typeCounts[$dev['device_id']] ?? [];
	}
	unset($dev);
}

$out = [
	'generated_at' => gmdate('Y-m-d\TH:i:s\Z'),
	'stale_seconds' => $staleSeconds,
	'expired_hours' => $expiredHours,
	'stations' => $stations,
	'hazards' => $hazards,
	'heatmap' => $heatmap,
	'intersections' => $intersections,
	'traffic_lights' => $trafficLights,
	'devices' => $devices,
];
if ($schemaMissing) {
	$out['warning'] = 'One or more expected tables are missing -- has schema.sql been applied to the its_bridge database yet?';
}

echo json_encode($out, JSON_UNESCAPED_SLASHES);
