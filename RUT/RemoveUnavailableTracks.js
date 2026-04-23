// RemoveUnavailableTracks.js
// Robust Spicetify extension to remove unavailable tracks from a playlist
// Features: pagination, null-track handling, batched deletes, 429 retry, debug logs

(async function RemoveUnavailableTracks() {
  const DEBUG = false; // set true to enable verbose console logs
  const BATCH_SIZE = 100; // Spotify API max per request for playlist tracks
  const RETRY_AFTER_DEFAULT = 1000; // ms

  const toast = Spicetify?.Toast || { show: (m) => console.log('Toast:', m) };
  const ctxMenu = Spicetify?.ContextMenu || Spicetify?.Menu || null;

  function log(...args) {
    if (DEBUG) console.log('[RemoveUnavailableTracks]', ...args);
  }

  function getToken() {
    try {
      return Spicetify.Platform.Player.getAccessToken();
    } catch (e) {
      return null;
    }
  }

  async function fetchAllPlaylistItems(playlistId) {
    const token = getToken();
    if (!token) throw new Error('No access token available');
    const limit = 100;
    let offset = 0;
    let items = [];
    while (true) {
      const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`;
      log('Fetching', url);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429) {
        const wait = (res.headers.get('Retry-After') || 1) * 1000;
        log('Rate limited, waiting', wait);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to fetch tracks: ${res.status} ${text}`);
      }
      const data = await res.json();
      items = items.concat(data.items || []);
      if (!data.next) break;
      offset += limit;
    }
    return items;
  }

  function detectUnavailable(item) {
    // Consider unavailable if track is null or track.is_playable === false
    if (!item || !item.track) return true;
    if (item.track.is_playable === false) return true;
    // Some removed tracks show as local or have no uri; treat missing uri as unavailable
    if (!item.track.uri) return true;
    return false;
  }

  function groupIntoBatches(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  async function deleteTracksByUris(playlistId, uris) {
    const token = getToken();
    if (!token) throw new Error('No access token available');
    const batches = groupIntoBatches(uris, BATCH_SIZE);
    let removedCount = 0;

    for (const batch of batches) {
      const body = { tracks: batch.map(u => ({ uri: u })) };
      let attempt = 0;
      while (true) {
        attempt++;
        const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          removedCount += batch.length;
          log(`Deleted batch of ${batch.length}`);
          break;
        }
        if (res.status === 429) {
          const wait = (res.headers.get('Retry-After') || 1) * 1000 || RETRY_AFTER_DEFAULT;
          log('Delete rate limited, waiting', wait);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        // For 403/401 or other errors, stop and surface error
        const text = await res.text();
        throw new Error(`Failed to delete tracks: ${res.status} ${text}`);
      }
    }
    return removedCount;
  }

  async function runOnPlaylistUri(playlistUri) {
    try {
      toast.show('Scanning playlist for unavailable tracks...');
      log('Playlist URI', playlistUri);
      const playlistId = playlistUri.split(':').pop();
      if (!playlistId) throw new Error('Invalid playlist URI');

      const items = await fetchAllPlaylistItems(playlistId);
      log('Total items fetched', items.length);

      // Collect URIs of unavailable tracks
      const unavailableUris = [];
      items.forEach((item, idx) => {
        if (detectUnavailable(item)) {
          // If track exists but no uri, try to use snapshot info; otherwise push placeholder
          const uri = item && item.track && item.track.uri ? item.track.uri : null;
          if (uri) unavailableUris.push(uri);
          else {
            // If no uri, we cannot remove by uri; skip but log
            log('Skipping item without URI at index', idx, item);
          }
        }
      });

      if (!unavailableUris.length) {
        toast.show('No unavailable tracks found.');
        return;
      }

      toast.show(`Removing ${unavailableUris.length} unavailable track(s)...`);
      const removed = await deleteTracksByUris(playlistId, unavailableUris);
      toast.show(`Removed ${removed} unavailable track(s).`);
      log('Done. Removed count', removed);
    } catch (err) {
      console.error('[RemoveUnavailableTracks] Error', err);
      toast.show('Error: ' + (err.message || 'unknown'));
    }
  }

  function getPlaylistUriFromTarget(target) {
    // target may be a playlist element or context object
    try {
      if (!target) return Spicetify.Platform.Player.data?.context?.uri || null;
      if (typeof target === 'string' && target.includes('playlist')) return target;
      if (target.uri && target.uri.includes('playlist')) return target.uri;
      if (target.dataset && target.dataset.uri && target.dataset.uri.includes('playlist')) return target.dataset.uri;
    } catch (e) {
      log('getPlaylistUriFromTarget error', e);
    }
    return null;
  }

  function addContextMenu() {
    if (!ctxMenu || !ctxMenu.addMenuItem) {
      // Fallback: try to attach to Spicetify.ContextMenu
      if (Spicetify.ContextMenu && Spicetify.ContextMenu.addMenuItem) {
        Spicetify.ContextMenu.addMenuItem('Remove unavailable tracks', async (target) => {
          const uri = getPlaylistUriFromTarget(target);
          if (!uri) return toast.show('Select a playlist first.');
          await runOnPlaylistUri(uri);
        });
        log('Context menu added via Spicetify.ContextMenu');
        return;
      }
      log('Context menu API not found; extension will not add menu item.');
      return;
    }

    ctxMenu.addMenuItem('Remove unavailable tracks', async (target) => {
      const uri = getPlaylistUriFromTarget(target);
      if (!uri) return toast.show('Select a playlist first.');
      await runOnPlaylistUri(uri);
    });
    log('Context menu item registered');
  }

  // Auto-run registration
  try {
    addContextMenu();
    log('RemoveUnavailableTracks loaded');
  } catch (e) {
    console.error('[RemoveUnavailableTracks] Initialization error', e);
  }
})();
