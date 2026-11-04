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
  const RECONNECT_MS = 5000;
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
  /** Context name by URI: a playlist name may need a request, made once. */
  const contextNames = new Map();

  function currentItem() {
    return Spicetify.Player.data?.item ?? Spicetify.Player.data?.track;
  }

  function artworkUrl(item) {
    const image = item.metadata?.image_url ?? item.album?.images?.[0]?.url ?? "";
    if (image.startsWith("spotify:image:")) return `https://i.scdn.co/image/${image.slice("spotify:image:".length)}`;
    return image.startsWith("https://i.scdn.co/image/") ? image : "";
  }

  /** The playing track, or null: paused, an episode, an ad or a local file are not shared. */
  function readTrack() {
    const item = currentItem();
    if (!item || !TRACK_URI.test(item.uri ?? "") || !Spicetify.Player.isPlaying()) return null;
    const artists = item.artists?.map((artist) => artist.name).join(", ") || item.metadata?.artist_name || "";
    return {
      uri: item.uri,
      title: item.name ?? item.metadata?.title ?? "",
      artist: artists,
      album: item.album?.name ?? item.metadata?.album_title ?? "",
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
    const uri = Spicetify.Player.data?.context?.uri ?? Spicetify.Player.data?.context_uri ?? "";
    if (!CONTEXT_URI.test(uri)) return null;
    if (!contextNames.has(uri)) {
      const name = contextNameFromState(uri, item);
      contextNames.set(uri, name);
      if (!name) {
        void fetchContextName(uri).then((fetched) => {
          if (!fetched) return;
          contextNames.set(uri, fetched);
          sendState();
        });
      }
    }
    return { uri, name: contextNames.get(uri).slice(0, 200) };
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function sendState() {
    const track = readTrack();
    send({
      type: "state",
      track,
      positionMs: track ? Math.max(0, Math.round(Spicetify.Player.getProgress())) : 0,
      positionAt: Date.now(),
      context: track ? readContext(currentItem()) : null,
    });
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

  /** What plays after the queue: the rest of the playlist or album, then Spotify's autoplay. Read-only. */
  function readUpcoming() {
    return (Spicetify.Queue?.nextTracks ?? [])
      .filter((entry) => entry.provider === "context" || entry.provider === "autoplay")
      .map((entry) => entry.contextTrack ?? {})
      .filter((track) => TRACK_URI.test(track.uri ?? ""))
      .slice(0, MAX_SHOWN_UPCOMING)
      .map((track) => ({
        uri: track.uri,
        title: track.metadata?.title ?? "",
        artist: track.metadata?.artist_name ?? "",
        artworkUrl: artworkUrl(track),
      }));
  }

  /** The name of the playing playlist or album, when it is one; empty otherwise. */
  function playingContextName() {
    const context = readContext(currentItem());
    return context?.name ?? "";
  }

  /** Sends the queue when it changed, or always when forced (the desktop app just connected). */
  function sendQueue(force = false) {
    const state = { tracks: readQueue(), upcoming: readUpcoming(), contextName: playingContextName() };
    const serialized = JSON.stringify(state);
    if (!force && serialized === sentQueue) return;
    sentQueue = serialized;
    send({ type: "queue", ...state });
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
    if (message?.type === "follow") void follow(message);
    else if (message?.type === "home-jam") setHomeJam(message.hostName);
    else if (message?.type === "enqueue") void enqueue(message);
    else if (message?.type === "dequeue") void dequeue(message);
    else if (message?.type === "move") void move(message);
    else if (message?.type === "like") void like(message);
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
      setHomeJam(null);
      setTimeout(connect, RECONNECT_MS);
    });
  }

  Spicetify.Player.addEventListener("songchange", sendState);
  Spicetify.Player.addEventListener("onplaypause", sendState);
  setInterval(sendState, STATE_INTERVAL_MS);
  setInterval(() => sendQueue(), QUEUE_POLL_MS);
  registerQueueMenu();
  connect();
})();
