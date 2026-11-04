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

  let socket;
  let connectedOnce = false;
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

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === "follow") void follow(message);
    // "unfollow": the track keeps playing, as after any other choice of the user.
  }

  function connect() {
    socket = new WebSocket(DESKTOP_URL);
    socket.addEventListener("open", () => {
      send({ type: "hello", version: PROTOCOL_VERSION });
      sendState();
      if (!connectedOnce) Spicetify.showNotification("WorkAdventure connecté", false, 4000);
      connectedOnce = true;
    });
    socket.addEventListener("message", onMessage);
    // The desktop app is not always running: try again quietly.
    socket.addEventListener("close", () => setTimeout(connect, RECONNECT_MS));
  }

  Spicetify.Player.addEventListener("songchange", sendState);
  Spicetify.Player.addEventListener("onplaypause", sendState);
  setInterval(sendState, STATE_INTERVAL_MS);
  connect();
})();
