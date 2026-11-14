<?php
require_once('includes/Monitor.php');
require_once('includes/Event.php');

if ( empty($_REQUEST['mid']) ) {
  ajaxError('No monitor id supplied');
} else if ( !isset($_REQUEST['zid']) ) {
  ajaxError('No zone id(s) supplied');
}

$monitor = new ZM\Monitor(validCardinal($_REQUEST['mid']));
// A zone editing tool, and a run costs real CPU: same permission as saving.
if ( !$monitor->Id() or !$monitor->canEdit() ) {
  ajaxError('Insufficient permissions');
}

if ( isset($_REQUEST['command']) and $_REQUEST['command'] == 'test' ) {
  // Re-run detection over a recorded event with the form's zone settings, via
  // zma --dry-run so nothing is written. The zone must exist: zma rebuilds it
  // from its saved row with the form's values laid over it.
  $zid = validCardinal($_REQUEST['zid']);
  if ( !$zid or !dbFetchOne('SELECT Id FROM Zones WHERE Id=? AND MonitorId=?', 'Id', array($zid, $monitor->Id())) ) {
    ajaxError('Save the zone before testing it');
  }
  $event = new ZM\Event(validCardinal(isset($_REQUEST['eid']) ? $_REQUEST['eid'] : 0));
  if ( !$event->Id() or $event->MonitorId() != $monitor->Id() or !$event->canView() ) {
    ajaxError('Unknown event for this monitor');
  }

  $zma = ZM_PATH_BIN.'/zma';
  if ( !is_executable($zma) ) {
    ajaxError('zma is not installed');
  }

  // Each value as the Zones table stores it; anything else is refused rather
  // than passed to a shell.
  $numeric = array(
    'MinPixelThreshold', 'MaxPixelThreshold', 'FilterX', 'FilterY',
    'MinAlarmPixels', 'MaxAlarmPixels', 'MinFilterPixels', 'MaxFilterPixels',
    'MinBlobPixels', 'MaxBlobPixels', 'MinBlobs', 'MaxBlobs',
  );
  $newZone = isset($_REQUEST['newZone']) && is_array($_REQUEST['newZone']) ? $_REQUEST['newZone'] : array();
  $sets = array();
  foreach ( $numeric as $field ) {
    if ( !isset($newZone[$field]) ) continue;
    $value = trim($newZone[$field]);
    if ( $value !== '' and !preg_match('/^\d+(\.\d+)?$/', $value) ) {
      ajaxError("Invalid value for $field");
    }
    $sets[] = $field.'='.$value;
  }
  if ( isset($newZone['CheckMethod']) ) {
    $method = array_search($newZone['CheckMethod'], array('AlarmedPixels', 'FilteredPixels', 'Blobs'), true);
    if ( $method === false ) ajaxError('Invalid CheckMethod');
    $sets[] = 'CheckMethod='.($method + 1);
  }
  if ( isset($newZone['Coords']) ) {
    // getCoordString() always writes two decimals, and Zone::LoadRow reads a
    // '.' in Coords as "percent", so insist on that form.
    if ( !preg_match('/^\d+\.\d+,\d+\.\d+( \d+\.\d+,\d+\.\d+){2,}$/', $newZone['Coords']) ) {
      ajaxError('Invalid Coords');
    }
    $sets[] = 'Coords='.$newZone['Coords'];
  }

  $command = escapeshellarg($zma).' --dry-run --json -e '.escapeshellarg($event->Id())
    .' -z '.escapeshellarg($zid);
  foreach ( $sets as $set ) $command .= ' -s '.escapeshellarg($set);

  ZM\Debug("Zone test: $command");
  $output = array();
  exec($command.' 2>/dev/null', $output, $status);

  $result = array('zones' => array(), 'frames' => array(), 'done' => null);
  foreach ( $output as $line ) {
    $row = json_decode($line, true);
    if ( !is_array($row) or !isset($row['type']) ) continue;
    if ( $row['type'] == 'zones' ) {
      $result['zones'] = $row['zones'];
    } else if ( $row['type'] == 'frame' ) {
      $result['frames'][] = $row;
    } else if ( $row['type'] == 'done' ) {
      $result['done'] = $row;
    } else if ( $row['type'] == 'error' ) {
      ajaxError('zma: '.$row['message']);
    }
  }
  if ( $result['done'] === null ) {
    // No JSON at all usually means a zma from before --json existed.
    ajaxError($status ? "zma failed (exit $status) - see the zma_e".$event->Id().' log' : 'zma returned no results');
  }
  ajaxResponse($result);
}

ajaxError('Unrecognised action or insufficient permissions');
?>
