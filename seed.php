<?php
// Dev utility: fill/clear dummy CAM stations + DENM hazards so the map
// viewer has something to show before the real bridge has traffic nearby.
//
// Everything this script writes is tagged with device_id = DUMMY_DEVICE_ID,
// which is how "clear" finds and removes exactly (and only) what "fill"
// added -- it never touches rows from the real esp32-c3-bridge.
//
// NOTE: schema.sql defines `position` as a generated column
// (POINT AS (POINT(longitude_deg, latitude_deg)) STORED). On the live DB
// it actually exists as a plain POINT NOT NULL column with no default --
// the generated-column clause did not survive schema.sql being applied on
// this MariaDB build. So every INSERT here sets `position` explicitly;
// see the warning printed by the "fill" action for what this means for the
// real bridge.
//
// Usage: seed.php?action=fill[&count=12]   seed.php?action=clear
error_reporting(E_ALL);
mysqli_report(MYSQLI_REPORT_OFF);

const DUMMY_DEVICE_ID = 'seed-dummy';
// Frankfurt am Main city centre, scattered within a few km.
const CENTER_LAT = 50.1109;
const CENTER_LON = 8.6821;
const SPREAD_DEG = 0.03;

require __DIR__ . '/env.php';
$l = mysqli_connect($DB_HOST, $DB_USER, $DB_PASSWORD, $DB_NAME);
if (!$l) {
	http_response_code(500);
	header('Content-Type: text/plain');
	die('db connect failed: ' . mysqli_connect_error());
}

function randFloat(float $min, float $max): float {
	return $min + mt_rand() / mt_getrandmax() * ($max - $min);
}

// Locally-administered, clearly-fake MAC (02:xx set = "locally administered",
// never assigned to real hardware by a vendor).
function fakeMac(): string {
	$bytes = [0x02];
	for ($i = 0; $i < 5; $i++) $bytes[] = mt_rand(0, 255);
	return implode(':', array_map(fn($b) => sprintf('%02x', $b), $bytes));
}

// Insert a dummy packets + its_messages row so api.php's join picks up a
// fake source MAC and message type for this station, same as a real one.
function insertShimMessage(mysqli $l, int $stationId, string $messageType, string $mac): void {
	$deviceId = DUMMY_DEVICE_ID;
	$now = date('Y-m-d H:i:s');
	$topic = 'its/' . DUMMY_DEVICE_ID . '/packet';

	$stmt = $l->prepare(
		"INSERT INTO packets (device_id, mqtt_topic, received_at, raw_len, raw_payload)
		 VALUES (?, ?, ?, 1, 0x00)"
	);
	$stmt->bind_param('sss', $deviceId, $topic, $now);
	$stmt->execute();
	$packetId = $l->insert_id;
	$stmt->close();

	$stmt = $l->prepare(
		"INSERT INTO its_messages (packet_id, device_id, received_at, protocol_version, message_id,
		                            message_type, station_id, asn1_variant, source_mac)
		 VALUES (?, ?, ?, 2, 2, ?, ?, ?, ?)"
	);
	$stmt->bind_param('isssiss', $packetId, $deviceId, $now, $messageType, $stationId, $messageType, $mac);
	$stmt->execute();
	$stmt->close();
}

$action = $_GET['action'] ?? '';

if ($action === 'fill') {
	$count = isset($_GET['count']) ? max(1, min(200, (int)$_GET['count'])) : 12;
	$now = date('Y-m-d H:i:s');
	$deviceId = DUMMY_DEVICE_ID;
	$stationTypes = [5, 5, 5, 5, 6, 7, 2, 4]; // mostly passenger cars, a few others
	$stationCount = 0;

	for ($i = 0; $i < $count; $i++) {
		$stationId = 900000000 + $i;
		$lat = CENTER_LAT + randFloat(-SPREAD_DEG, SPREAD_DEG);
		$lon = CENTER_LON + randFloat(-SPREAD_DEG, SPREAD_DEG);
		$heading = randFloat(0, 359.9);
		$speed = randFloat(0, 25);
		$stationType = $stationTypes[array_rand($stationTypes)];
		$mac = fakeMac();

		insertShimMessage($l, $stationId, 'cam', $mac);

		// `position` is set explicitly (POINT(lon, lat)) because the live
		// column is a plain NOT NULL POINT, not the generated column
		// schema.sql defines -- see file header note.
		$stmt = $l->prepare(
			"INSERT INTO stations (station_id, device_id, station_type, last_message_type,
			                        latitude_deg, longitude_deg, position, heading_deg, speed_m_s,
			                        vehicle_length_m, vehicle_width_m, first_seen, last_seen)
			 VALUES (?, ?, ?, 'cam', ?, ?, POINT(?, ?), ?, ?, 4.5, 1.8, ?, ?)
			 ON DUPLICATE KEY UPDATE device_id=VALUES(device_id), station_type=VALUES(station_type),
			     latitude_deg=VALUES(latitude_deg), longitude_deg=VALUES(longitude_deg),
			     position=VALUES(position), heading_deg=VALUES(heading_deg),
			     speed_m_s=VALUES(speed_m_s), last_seen=VALUES(last_seen)"
		);
		$stmt->bind_param('isiddddddss', $stationId, $deviceId, $stationType, $lat, $lon, $lon, $lat, $heading, $speed, $now, $now);
		$stmt->execute();
		$stmt->close();

		$stationCount++;
	}
/*
	// A couple of active DENM hazards nearby.
	$hazards = [
		['cause' => 2, 'sub' => 0], // accident
		['cause' => 3, 'sub' => 1], // roadworks
	];
	$hazardCount = 0;
	foreach ($hazards as $j => $h) {
		$stationId = 900000900 + $j;
		$lat = CENTER_LAT + randFloat(-SPREAD_DEG, SPREAD_DEG);
		$lon = CENTER_LON + randFloat(-SPREAD_DEG, SPREAD_DEG);
		$mac = fakeMac();
		$expires = date('Y-m-d H:i:s', time() + 600);

		insertShimMessage($l, $stationId, 'denm', $mac);

		$stmt = $l->prepare(
			"INSERT INTO denm_events (originating_station_id, sequence_number, device_id, station_id,
			                           station_type, cause_code, sub_cause_code, is_active,
			                           validity_duration_s, expires_at, latitude_deg, longitude_deg,
			                           position, first_received_at, last_received_at)
			 VALUES (?, 1, ?, ?, 5, ?, ?, 1, 600, ?, ?, ?, POINT(?, ?), ?, ?)
			 ON DUPLICATE KEY UPDATE latitude_deg=VALUES(latitude_deg), longitude_deg=VALUES(longitude_deg),
			     position=VALUES(position), expires_at=VALUES(expires_at), last_received_at=VALUES(last_received_at)"
		);
		$stmt->bind_param('isiiisddddss', $stationId, $deviceId, $stationId, $h['cause'], $h['sub'],
			$expires, $lat, $lon, $lon, $lat, $now, $now);
		$stmt->execute();
		$stmt->close();

		$hazardCount++;
	}
*/
	header('Content-Type: text/plain');
	echo "Inserted/updated $stationCount dummy stations and $hazardCount dummy hazards around Frankfurt.\n";
	echo "View: /d/citsviewer/index.html\n";
	echo "Remove them again: /d/citsviewer/seed.php?action=clear\n";
	echo "\nNOTE: the live `position` column on stations/cam_messages/denm_events\n";
	echo "is a plain NOT NULL POINT, not schema.sql's generated column. This\n";
	echo "script works around it, but mqtt_to_mysql.py's real INSERTs do not\n";
	echo "set `position` and will fail once real CAM/DENM traffic arrives.\n";
	exit;
}

if ($action === 'clear') {
	// Deleting packets cascades to its_messages (FK ON DELETE CASCADE).
	$l->query("DELETE FROM packets WHERE device_id = '" . DUMMY_DEVICE_ID . "'");
	$packets = $l->affected_rows;
	$l->query("DELETE FROM stations WHERE device_id = '" . DUMMY_DEVICE_ID . "'");
	$stations = $l->affected_rows;
	$l->query("DELETE FROM denm_events WHERE device_id = '" . DUMMY_DEVICE_ID . "'");
	$hazards = $l->affected_rows;

	header('Content-Type: text/plain');
	echo "Removed $stations dummy stations, $hazards dummy hazards, $packets dummy packets/messages.\n";
	exit;
}

header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<meta charset="utf-8">
<title>C-ITS dummy data seeder</title>
<body style="font-family:sans-serif;max-width:520px;margin:40px auto;line-height:1.5">
<h1>C-ITS dummy data seeder</h1>
<p>Adds or removes fake CAM stations / DENM hazards scattered around Frankfurt am Main, all tagged with
<code>device_id = '<?= htmlspecialchars(DUMMY_DEVICE_ID) ?>'</code> so they never mix with real bridge data.</p>
<p>
	<a href="?action=fill">Fill with 12 dummy stations + 2 hazards</a><br>
	<a href="?action=fill&count=50">Fill with 50 dummy stations</a><br>
	<a href="?action=clear">Clear all dummy data</a>
</p>
<p><a href="index.html">&larr; back to the map</a></p>
</body>
