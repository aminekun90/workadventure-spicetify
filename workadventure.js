// WorkAdventure Spicetify v1.4.3
// WorkAdventure for Spicetify: lets the WorkAdventure desktop app read what this Spotify plays (track, position and
// the playlist or album it plays from) and play along with another user ("Écouter en même temps"), Spotify Free
// included. It only talks to the desktop app, on this computer (127.0.0.1); nothing else leaves Spotify.
(function workadventure() {
  const Spicetify = window.Spicetify;
  if (!Spicetify?.Player?.playUri || !Spicetify.Player.addEventListener || !Spicetify.showNotification) {
    setTimeout(workadventure, 300);
    return;
  }

  /** Must match SPICETIFY_BRIDGE_PORT in workadventure-desktop. */
  const DESKTOP_URL = "ws://127.0.0.1:47613";
  const PROTOCOL_VERSION = 1;
  const RECONNECT_MS = 1000;
  /** Positions move every second: a periodic state lets the desktop app notice a seek. */
  const STATE_INTERVAL_MS = 10_000;
  /** Closer than that to the followed position: no seek, it would be heard. */
  const FOLLOW_TOLERANCE_MS = 3000;
  /** playUri resolves before the new track is ready to seek. */
  const SEEK_DELAY_MS = 500;
  const TRACK_URI = /^spotify:track:[A-Za-z0-9]+$/;
  /** Only a playlist or an album is shared: others can open it (not an artist, a radio or the liked songs). */
  const CONTEXT_URI = /^spotify:(playlist|album):[A-Za-z0-9]+$/;

  /** Most tracks one request adds to the Jukebox: the desktop app refuses more. */
  const MAX_QUEUED_TRACKS = 5;
  /** The queue is read this often and sent to the desktop app when it changed (Spotify has no queue event). */
  const QUEUE_POLL_MS = 2000;
  /** Tracks of the queue shown in WorkAdventure. */
  const MAX_SHOWN_QUEUE = 30;
  /** Tracks still to come from the playing playlist or album, shown after the queue. */
  const MAX_SHOWN_UPCOMING = 20;
  /** addToQueue resolves before the queue lists the new tracks. */
  const QUEUE_SETTLE_MS = 600;

  let socket;
  let connectedOnce = false;
  /** The host's name while this user takes part in a Jukebox as a guest, null otherwise. */
  let homeJamHost = null;
  let queueMenuItem;
  /** Who added each queued track (by its queue uid): name and WorkAdventure uuid; the host's own additions are unnamed. */
  const addedBy = new Map();
  let sentQueue = "";
  /** Context names by URI; unavailable metadata is retried while the context remains active. */
  const contextNames = new Map();
  const contextRequests = new Set();
  const contextRetryAt = new Map();
  const CONTEXT_RETRY_MS = 5000;

  // Spotify's own analysis, aligned with this player's position; never a made-up tempo.
  let musicWatching = false;
  let playbackWatching = false;
  let analysisUri;
  let analysis;
  let analysisGeneration = 0;
  const MUSIC_INTERVAL_MS = 50;

  async function loadAnalysis(uri) {
    const generation = ++analysisGeneration;
    analysisUri = uri;
    analysis = undefined;
    try {
      const data = await Spicetify.getAudioData?.(uri);
      if (generation !== analysisGeneration || !musicWatching) return;
      if (Array.isArray(data?.beats) && Array.isArray(data?.segments)) analysis = data;
    } catch {
      // Some tracks/accounts have no analysis: report no signal, never invent beats.
    }
  }

  function atPosition(entries, seconds) {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (entries[middle].start <= seconds) low = middle + 1;
      else high = middle;
    }
    return entries[low - 1];
  }

  function sendMusic() {
    if (!musicWatching || socket?.readyState !== WebSocket.OPEN) return;
    const track = readTrack();
    if (!track) {
      send({ type: "music", frame: null });
      return;
    }
    if (analysisUri !== track.uri) void loadAnalysis(track.uri);
    const seconds = Spicetify.Player.getProgress() / 1000;
    const beat = analysis && atPosition(analysis.beats, seconds);
    const segment = analysis && atPosition(analysis.segments, seconds);
    const loudness = segment?.loudness_max;
    if (!beat || !Number.isFinite(beat.start) || !Number.isFinite(loudness)) {
      send({ type: "music", frame: null });
      return;
    }
    const bar = atPosition(analysis.bars ?? [], seconds);
    const unit = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    send({ type: "music", frame: {
      uri: track.uri,
      beatStartMs: Math.max(0, Math.round(beat.start * 1000)),
      // Loudness over the last 40 dB: the quiet parts of a track still move, the loud ones fill the room.
      intensity: unit((loudness + 40) / 40),
      // A kick or a bass note is a sharp rise of loudness at the start of a segment: what the lights hit on.
      attack: unit((loudness - (segment.loudness_start ?? loudness)) / 25),
      // Spotify's second timbre value tells dull (bass) from bright (hi-hats, cymbals) sounds.
      brightness: unit(((segment.timbre?.[1] ?? 0) + 60) / 180),
      ...(bar && Number.isFinite(bar.start) && { barStartMs: Math.max(0, Math.round(bar.start * 1000)) }),
    } });
  }

  /** The desktop app refuses longer texts: a long album or a list of artists must not drop the whole state. */
  const MAX_TEXT = 200;
  const text = (value) => (typeof value === "string" ? value.slice(0, MAX_TEXT) : "");
  /** Spotify's state can be momentarily incomplete (a track loading): never send NaN, it would reject the state. */
  const milliseconds = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

  function currentItem() {
    return Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  }

  function artworkUrl(item) {
    const image = item.metadata?.image_url ?? item.album?.images?.[0]?.url ?? "";
    if (image.startsWith("spotify:image:")) return `https://i.scdn.co/image/${image.slice("spotify:image:".length)}`;
    return image.startsWith("https://i.scdn.co/image/") ? image : "";
  }

  /** The playing track, or null: paused, an episode, an ad or a local file are not shared. */
  function readTrack(includePaused = false) {
    const item = currentItem();
    if (!item || !TRACK_URI.test(item.uri ?? "") || (!includePaused && !Spicetify.Player.isPlaying())) return null;
    const artists = item.artists?.map((artist) => artist.name).join(", ") || item.metadata?.artist_name || "";
    return {
      uri: item.uri,
      title: text(item.name || item.metadata?.title) || "Spotify",
      artist: text(artists),
      album: text(item.album?.name ?? item.metadata?.album_title),
      artworkUrl: artworkUrl(item),
    };
  }

  /** The name the player state gives, or the album of the playing track. */
  function contextNameFromState(uri, item) {
    const context = Spicetify.Player.data?.context;
    const fromState = context?.uri === uri ? (context.metadata?.context_description ?? "") : "";
    if (fromState) return fromState;
    return item?.album?.uri === uri ? (item.album.name ?? "") : "";
  }

  async function fetchContextName(uri) {
    if (!uri.startsWith("spotify:playlist:")) return "";
    try {
      const metadata = await Spicetify.Platform?.PlaylistAPI?.getMetadata?.(uri);
      return typeof metadata?.name === "string" ? metadata.name : "";
    } catch (error) {
      console.warn("[workadventure] could not read the playlist name", error);
      return "";
    }
  }

  /** The playlist or album the track plays from, or null; a name still unknown is sent once it is read. */
  function readContext(item) {
    const uri = Spicetify.Player.data?.context?.uri || Spicetify.Player.data?.context_uri || "";
    if (!CONTEXT_URI.test(uri)) return null;
    const name = contextNameFromState(uri, item);
    if (name) contextNames.set(uri, name);
    if (!contextNames.has(uri) && !contextRequests.has(uri) && Date.now() >= (contextRetryAt.get(uri) ?? 0)) {
      contextRequests.add(uri);
      contextRetryAt.set(uri, Date.now() + CONTEXT_RETRY_MS);
      void fetchContextName(uri).then((fetched) => {
        // A new playlist may not have metadata yet: never cache that absence for the Spotify session.
        if (!fetched) return;
        contextNames.set(uri, fetched);
        sendState();
        sendQueue(true);
      }).finally(() => contextRequests.delete(uri));
    }
    return { uri, name: (contextNames.get(uri) ?? "").slice(0, 200) };
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendState() {
    const track = readTrack();
    send({
      type: "state",
      track,
      positionMs: track ? milliseconds(Spicetify.Player.getProgress()) : 0,
      positionAt: Date.now(),
      context: track ? readContext(currentItem()) : null,
    });
    sendPlayback();
  }

  function sendPlayback() {
    if (!playbackWatching || socket?.readyState !== WebSocket.OPEN) return;
    const volume = Spicetify.Player.getVolume?.();
    const repeat = Spicetify.Player.getRepeat?.();
    send({ type: "playback-state", state: {
      track: readTrack(true),
      playing: Spicetify.Player.isPlaying(),
      positionMs: milliseconds(Spicetify.Player.getProgress()),
      durationMs: Math.min(86_400_000, milliseconds(Spicetify.Player.getDuration?.())),
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1,
      shuffle: Spicetify.Player.getShuffle?.() === true,
      repeat: repeat === 1 || repeat === 2 ? repeat : 0,
    } });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function follow({ uri, positionMs }) {
    if (!TRACK_URI.test(uri) || !Number.isFinite(positionMs) || positionMs < 0) return;
    const receivedAt = Date.now();
    try {
      if (currentItem()?.uri !== uri) {
        await Spicetify.Player.playUri(uri);
        await wait(SEEK_DELAY_MS);
        Spicetify.Player.seek(positionMs + (Date.now() - receivedAt));
      } else if (Math.abs(Spicetify.Player.getProgress() - positionMs) > FOLLOW_TOLERANCE_MS) {
        Spicetify.Player.seek(positionMs);
      }
      if (!Spicetify.Player.isPlaying()) Spicetify.Player.play();
    } catch (error) {
      console.error("[workadventure] could not play along", error);
    }
  }

  const queueableTracks = (uris) =>
    Array.isArray(uris) ? uris.filter((uri) => TRACK_URI.test(uri)).slice(0, MAX_QUEUED_TRACKS) : [];

  /** The tracks added to the queue (not those of the playing playlist), as WorkAdventure shows them. */
  function readQueue() {
    return (Spicetify.Queue?.nextTracks ?? [])
      .filter((entry) => entry.provider === "queue")
      .map((entry) => entry.contextTrack ?? {})
      .filter((track) => TRACK_URI.test(track.uri ?? "") && typeof track.uid === "string" && track.uid)
      .slice(0, MAX_SHOWN_QUEUE)
      .map((track) => ({
        uri: track.uri,
        uid: track.uid,
        title: track.metadata?.title ?? "",
        artist: track.metadata?.artist_name ?? "",
        artworkUrl: artworkUrl(track),
        addedBy: addedBy.get(track.uid)?.name ?? "",
        addedByUuid: addedBy.get(track.uid)?.uuid ?? "",
      }));
  }

  /**
   * What plays after the queue: the rest of the playlist or album, then Spotify's autoplay. Spotify moves and removes
   * these too (for this playback only: the playlist itself is not changed), so they carry their queue uid.
   */
  function readUpcoming() {
    return (Spicetify.Queue?.nextTracks ?? [])
      .filter((entry) => entry.provider === "context" || entry.provider === "autoplay")
      .map((entry) => entry.contextTrack ?? {})
      .filter((track) => TRACK_URI.test(track.uri ?? ""))
      .slice(0, MAX_SHOWN_UPCOMING)
      .map((track) => ({
        uri: track.uri,
        // Fresh playback contexts can expose tracks before Spotify assigns their queue uid.
        ...(typeof track.uid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(track.uid) ? { uid: track.uid } : {}),
        title: (track.metadata?.title ?? "").slice(0, 200),
        artist: (track.metadata?.artist_name ?? "").slice(0, 200),
        artworkUrl: artworkUrl(track),
      }));
  }

  /** The name of the playing playlist or album, when it is one; empty otherwise. */
  function playingContextName() {
    const context = readContext(currentItem());
    return context?.name ?? "";
  }

  /**
   * As a Jukebox guest: what the user adds to their own queue with Spotify's own "Add to queue" goes to the host's
   * queue instead (the host plays it for everyone, this Spotify follows), then leaves the local queue.
   */
  async function forwardLocalQueue() {
    if (homeJamHost === null || socket?.readyState !== WebSocket.OPEN) return;
    const added = readQueue().slice(0, MAX_QUEUED_TRACKS);
    if (added.length === 0) return;
    send({ type: "queue-request", uris: added.map((track) => track.uri) });
    try {
      await Spicetify.removeFromQueue(added.map((track) => ({ uri: track.uri, uid: track.uid })));
    } catch (error) {
      console.error("[workadventure] could not move the queue to the Jukebox", error);
    }
    Spicetify.showNotification(`Envoyé au Jukebox de ${homeJamHost || "l'hôte"}`, false, 3000);
  }

  /** Sends the queue when it changed, or always when forced (the desktop app just connected). */
  function sendQueue(force = false) {
    const state = { tracks: readQueue(), upcoming: readUpcoming(), contextName: playingContextName() };
    const serialized = JSON.stringify(state);
    if (!force && serialized === sentQueue) return;
    sentQueue = serialized;
    send({ type: "queue", ...state });
  }

  /** Songchange can fire before Spotify updates the context and queue: read them again once settled. */
  function refreshPlayback() {
    sendState();
    sendQueue(true);
    setTimeout(() => {
      sendState();
      sendQueue(true);
    }, QUEUE_SETTLE_MS);
  }

  /** As the Jukebox's host: a participant's tracks go to the queue, remembered as theirs. */
  async function enqueue({ uris, from, fromUuid }) {
    const tracks = queueableTracks(uris);
    if (tracks.length === 0) return;
    const who = typeof from === "string" && from ? from.slice(0, 100) : "Quelqu'un";
    const whoUuid = typeof fromUuid === "string" ? fromUuid.slice(0, 256) : "";
    const known = new Set(readQueue().map((track) => track.uid));
    try {
      await Spicetify.addToQueue(tracks.map((uri) => ({ uri })));
      await wait(QUEUE_SETTLE_MS);
      for (const track of readQueue()) {
        if (!known.has(track.uid) && tracks.includes(track.uri)) addedBy.set(track.uid, { name: who, uuid: whoUuid });
      }
      const what = tracks.length > 1 ? `${tracks.length} morceaux` : "un morceau";
      Spicetify.showNotification(`${who} a ajouté ${what} au Jukebox`, false, 4000);
    } catch (error) {
      console.error("[workadventure] could not add to the queue", error);
    }
    sendQueue(true);
  }

  /** As the Jukebox's host: a track removed from WorkAdventure (by the host or a participant allowed to). */
  async function dequeue({ uri, uid }) {
    if (!TRACK_URI.test(uri ?? "") || typeof uid !== "string" || !uid) return;
    try {
      await Spicetify.removeFromQueue([{ uri, uid }]);
      // The queue still lists it for a moment: forgetting who added it now would show it unattributed.
      await wait(QUEUE_SETTLE_MS);
      addedBy.delete(uid);
    } catch (error) {
      console.error("[workadventure] could not remove from the queue", error);
    }
    sendQueue(true);
  }

  const isQueueEntry = (entry) => TRACK_URI.test(entry?.uri ?? "") && typeof entry?.uid === "string" && entry.uid !== "";

  /** As the Jukebox's host: moves a track before or after another one of the queue. */
  async function move({ uri, uid, before, after }) {
    const target = isQueueEntry(before) ? { before } : isQueueEntry(after) ? { after } : undefined;
    if (!isQueueEntry({ uri, uid }) || !target) return;
    // Who added it survives the move: Spotify may give the entry a new uid.
    const author = addedBy.get(uid);
    const known = new Set(readQueue().map((track) => track.uid));
    try {
      const entry = { uri, uid };
      const position = before ? { before: { uri: before.uri, uid: before.uid } } : { after: { uri: after.uri, uid: after.uid } };
      await Spicetify.Platform.PlayerAPI.reorderQueue([entry], position);
      await wait(QUEUE_SETTLE_MS);
      if (author) {
        const moved = readQueue().find((track) => track.uri === uri && (track.uid === uid || !known.has(track.uid)));
        if (moved) addedBy.set(moved.uid, author);
      }
    } catch (error) {
      console.error("[workadventure] could not move a queued track", error);
    }
    sendQueue(true);
  }

  /** Saves a track to this user's Liked Songs, from WorkAdventure (heart on a card or a Jukebox track). */
  async function like({ uri }) {
    if (!TRACK_URI.test(uri ?? "")) return;
    try {
      await Spicetify.Platform.LibraryAPI.add({ uris: [uri] });
      Spicetify.showNotification("Ajouté aux titres likés", false, 3000);
    } catch (error) {
      console.error("[workadventure] could not like a track", error);
    }
  }

  /** Volume before a mute from WorkAdventure, restored by the next one. */
  let volumeBeforeMute = 1;
  /** Spotify applies a command asynchronously: wait (briefly) until its state shows it, then report it. */
  const PLAYBACK_CONFIRM_MS = 1500;

  async function until(condition) {
    const deadline = Date.now() + PLAYBACK_CONFIRM_MS;
    while (!condition() && Date.now() < deadline) await wait(50);
  }

  async function setPlaying(playing) {
    // Already there (the page showed a stale state): only report the actual state, never toggle back.
    if (Spicetify.Player.isPlaying() === playing) return;
    const api = Spicetify.Platform?.PlayerAPI;
    if (playing) await (api?.resume ? api.resume() : Spicetify.Player.play());
    else await (api?.pause ? api.pause() : Spicetify.Player.pause());
    await until(() => Spicetify.Player.isPlaying() === playing);
  }

  async function toggleMute() {
    const volume = Spicetify.Player.getVolume();
    if (volume > 0) {
      volumeBeforeMute = volume;
      await Spicetify.Player.setVolume(0);
    } else await Spicetify.Player.setVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 0.5);
  }

  async function controlPlayback({ command, value }) {
    try {
      if (command === "play") await setPlaying(true);
      else if (command === "pause") await setPlaying(false);
      else if (command === "next") await Spicetify.Player.next();
      else if (command === "previous") await Spicetify.Player.back();
      // Spicetify's toggleMute clicks a button of Spotify's UI, absent from some layouts: drive the volume instead.
      else if (command === "mute") await toggleMute();
      else if (command === "shuffle") await Spicetify.Player.setShuffle(!Spicetify.Player.getShuffle());
      else if (command === "repeat") await Spicetify.Player.setRepeat((Spicetify.Player.getRepeat() + 1) % 3);
      else if (command === "volume" && Number.isFinite(value) && value >= 0 && value <= 1) await Spicetify.Player.setVolume(value);
      else if (command === "seek" && Number.isInteger(value) && value >= 0 && Spicetify.Player.getDuration() > 0) {
        // Spicetify interprets values <= 1 as a fraction, so use a fraction for every seek, including 0 ms.
        await Spicetify.Player.seek(Math.min(value / Spicetify.Player.getDuration(), 1));
      }
      else return;
      if (command === "next" || command === "previous") refreshPlayback();
      else sendState();
    } catch (error) {
      console.error("[workadventure] could not control playback", error);
      Spicetify.showNotification("Commande Spotify indisponible", true, 3000);
      sendState();
    }
  }

  function setHomeJam(hostName) {
    homeJamHost = typeof hostName === "string" ? hostName : null;
    if (queueMenuItem && homeJamHost !== null) queueMenuItem.name = `Ajouter au Jukebox de ${homeJamHost || "l'hôte"}`;
  }

  /** Right click on tracks, only while taking part in a Jukebox: they are sent to the host's queue. */
  function registerQueueMenu() {
    if (!Spicetify.ContextMenu?.Item) {
      setTimeout(registerQueueMenu, 300);
      return;
    }
    queueMenuItem = new Spicetify.ContextMenu.Item(
      "Ajouter au Jukebox",
      (uris) => {
        const tracks = queueableTracks(uris);
        if (tracks.length === 0 || homeJamHost === null) return;
        send({ type: "queue-request", uris: tracks });
        Spicetify.showNotification(`Envoyé au Jukebox de ${homeJamHost || "l'hôte"}`, false, 3000);
      },
      (uris) => homeJamHost !== null && socket?.readyState === WebSocket.OPEN && queueableTracks(uris).length === uris.length,
    );
    queueMenuItem.register();
  }

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === "music-watch") {
      musicWatching = message.watching === true;
      analysisGeneration++;
      analysisUri = undefined;
      analysis = undefined;
      sendMusic();
    }
    else if (message?.type === "playback-watch") {
      playbackWatching = message.watching === true;
      sendPlayback();
    }
    else if (message?.type === "playback") void controlPlayback(message);
    else if (message?.type === "follow") void follow(message);
    else if (message?.type === "home-jam") setHomeJam(message.hostName);
    else if (message?.type === "enqueue") void enqueue(message);
    else if (message?.type === "dequeue") void dequeue(message);
    else if (message?.type === "move") void move(message);
    else if (message?.type === "like") void like(message);
    else if (message?.type === "refresh-queue") {
      const uri = Spicetify.Player.data?.context?.uri || Spicetify.Player.data?.context_uri;
      contextRetryAt.delete(uri);
      refreshPlayback();
    }
    // "unfollow": the track keeps playing, as after any other choice of the user.
  }

  function connect() {
    socket = new WebSocket(DESKTOP_URL);
    socket.addEventListener("open", () => {
      send({ type: "hello", version: PROTOCOL_VERSION });
      sendState();
      sendQueue(true);
      if (!connectedOnce) Spicetify.showNotification("WorkAdventure connecté", false, 4000);
      connectedOnce = true;
    });
    socket.addEventListener("message", onMessage);
    // The desktop app is not always running: try again quietly. Without it, there is no Jukebox either.
    socket.addEventListener("close", () => {
      musicWatching = false;
      playbackWatching = false;
      analysisGeneration++;
      analysisUri = undefined;
      analysis = undefined;
      setHomeJam(null);
      setTimeout(connect, RECONNECT_MS);
    });
  }

  Spicetify.Player.addEventListener("songchange", refreshPlayback);
  Spicetify.Player.addEventListener("onplaypause", sendState);
  setInterval(sendState, STATE_INTERVAL_MS);
  setInterval(() => {
    sendQueue();
    void forwardLocalQueue();
  }, QUEUE_POLL_MS);
  setInterval(sendMusic, MUSIC_INTERVAL_MS);
  setInterval(sendPlayback, 1000);
  registerQueueMenu();
  connect();
})();
