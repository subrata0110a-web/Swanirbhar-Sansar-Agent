<?php
/**
 * Agent live-location tracking.
 *
 *  POST   -> Agent panel প্রতি ~30s এ নিজের lat/lng পাঠায়।
 *            agent_locations table এ upsert করে।
 *
 *  GET    -> Admin panel কোনো agent এর সর্বশেষ location দেখতে চাইলে।
 *
 *  DELETE -> Admin panel কোনো agent এর background tracking force-stop করতে চাইলে।
 *            এটা করলে:
 *              1. agent_locations থেকে সেই agent এর record মুছে যায়।
 *              2. agent এর সব auth_tokens delete হয় → SW এর পরের POST এ
 *                 401 আসবে → SW নিজেই IndexedDB clear করে tracking বন্ধ করবে।
 *              3. Response এ { stopped: true } দেয় → Admin.html এ
 *                 confirmation দেখাতে পারবে।
 */
require_once __DIR__ . '/../includes/bootstrap.php';
require_once __DIR__ . '/../includes/auth.php';

$method = $_SERVER['REQUEST_METHOD'];

/* ─────────────────────────────────────────
   POST — Agent নিজের location update করে
───────────────────────────────────────── */
if ($method === 'POST') {
    $agent = require_agent();
    $body  = json_body();
    require_fields($body, ['latitude', 'longitude']);

    $lat = (float) $body['latitude'];
    $lng = (float) $body['longitude'];
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
        json_error('Invalid coordinates', 422);
    }
    $accuracy = isset($body['accuracy']) && $body['accuracy'] !== '' ? (float) $body['accuracy'] : null;

    $stmt = db()->prepare(
        "INSERT INTO agent_locations (agent_id, latitude, longitude, accuracy, updated_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           latitude   = VALUES(latitude),
           longitude  = VALUES(longitude),
           accuracy   = VALUES(accuracy),
           updated_at = NOW()"
    );
    $stmt->execute([$agent['id'], $lat, $lng, $accuracy]);
    json_ok(['message' => 'Location updated']);
}

/* ─────────────────────────────────────────
   GET — Admin agent এর সর্বশেষ location দেখে
───────────────────────────────────────── */
if ($method === 'GET') {
    $ctx        = require_admin_area('agents');
    $subBranchId = $ctx['role'] === 'sub' ? require_own_branch($ctx) : null;

    $agentId = $_GET['agentId'] ?? null;
    if (!$agentId) json_error('Missing agentId', 422);

    if ($subBranchId !== null) {
        $stmt = db()->prepare("SELECT id FROM agents WHERE id = ? AND branch_id = ?");
        $stmt->execute([$agentId, $subBranchId]);
        if (!$stmt->fetch()) json_error('This agent does not belong to your branch', 403);
    }

    $stmt = db()->prepare(
        "SELECT al.agent_id, al.latitude, al.longitude, al.accuracy, al.updated_at,
                a.name AS agent_name
         FROM agent_locations al
         JOIN agents a ON a.id = al.agent_id
         WHERE al.agent_id = ?"
    );
    $stmt->execute([$agentId]);
    $row = $stmt->fetch();
    if (!$row) json_error('No location reported for this agent yet', 404);
    json_ok(['location' => $row]);
}

/* ─────────────────────────────────────────
   DELETE — Admin কোনো agent এর tracking force-stop করে।
   কাজের ধাপ:
     1. agent_locations থেকে record মুছো।
     2. agent এর সব auth_tokens মুছো → পরের SW ping এ 401 হবে।
        SW এ 401 পেলে IndexedDB clear করে tracking নিজেই বন্ধ হবে।
───────────────────────────────────────── */
if ($method === 'DELETE') {
    $ctx        = require_admin_area('agents');
    $subBranchId = $ctx['role'] === 'sub' ? require_own_branch($ctx) : null;

    $agentId = $_GET['agentId'] ?? null;
    if (!$agentId) json_error('Missing agentId', 422);

    // Sub-admin হলে নিজের branch এর agent কিনা check করো
    if ($subBranchId !== null) {
        $stmt = db()->prepare("SELECT id FROM agents WHERE id = ? AND branch_id = ?");
        $stmt->execute([$agentId, $subBranchId]);
        if (!$stmt->fetch()) json_error('This agent does not belong to your branch', 403);
    }

    // ১. location record মুছো
    db()->prepare("DELETE FROM agent_locations WHERE agent_id = ?")
        ->execute([$agentId]);

    // ২. agent এর সব token revoke করো → SW এর পরের ping এ 401 হবে
    db()->prepare("DELETE FROM auth_tokens WHERE user_type = 'agent' AND user_id = ?")
        ->execute([$agentId]);

    json_ok(['stopped' => true, 'message' => 'Agent tracking stopped and session revoked']);
}

json_error('Method not allowed', 405);
