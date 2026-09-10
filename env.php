<?php
// Minimal dependency-free .env loader (no Composer needed for one file).
// Real values live in .env (gitignored); .env.example documents the keys.
function load_env(string $path): array {
    $vars = [];
    if (!is_file($path)) {
        return $vars;
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
            continue;
        }
        [$key, $value] = explode('=', $line, 2);
        $vars[trim($key)] = trim($value);
    }
    return $vars;
}

function env_get(array $env, string $key, string $default = ''): string {
    return $env[$key] ?? (getenv($key) ?: $default);
}

$__env = load_env(__DIR__ . '/.env');

const DB_HOST_DEFAULT = '127.0.0.1';
const DB_USER_DEFAULT = 'its_bridge';
const DB_NAME_DEFAULT = 'its_bridge';

$DB_HOST = env_get($__env, 'MYSQL_HOST', DB_HOST_DEFAULT);
$DB_USER = env_get($__env, 'MYSQL_USER', DB_USER_DEFAULT);
$DB_PASSWORD = env_get($__env, 'MYSQL_PASSWORD', '');
$DB_NAME = env_get($__env, 'MYSQL_DATABASE', DB_NAME_DEFAULT);

// Optional: mqtt-bridge/mqtt_to_mysql.py's live-push WebSocket server (see
// its README's "Live push" section), e.g. "ws://192.168.0.21:8765". Empty
// means disabled -- app.js only attempts a connection once api.php hands
// it a non-empty ws_url, and falls back to plain polling either way.
$WS_URL = env_get($__env, 'WS_URL', '');
