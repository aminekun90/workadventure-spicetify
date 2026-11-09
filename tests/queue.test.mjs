import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../workadventure.js", import.meta.url), "utf8");

function extensionHarness(nextTracks, playerData, getMetadata, getAudioData) {
  const sent = [];
  let open;
  let onMessage;
  const timers = [];
  const events = {};
  const intervals = [];
  const controls = [];
  let volume = 0.5;
  let shuffle = false;
  let repeat = 0;
  let time = 10000;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name, callback) { if (name === "open") open = callback; if (name === "message") onMessage = callback; }
    send(message) { sent[sent.length] = JSON.parse(message); }
  }
  runInNewContext(source, {
    window: { Spicetify: {
      Player: { data: playerData, playUri() {},
        play() { controls[controls.length] = "play"; playerData.paused = false; },
        pause() { controls[controls.length] = "pause"; playerData.paused = true; },
        next() { controls[controls.length] = "next"; },
        back() { controls[controls.length] = "previous"; },
        getDuration: () => 120000,
        getVolume: () => volume,
        setVolume(value) { volume = value; },
        toggleMute() { volume = volume === 0 ? 0.5 : 0; },
        getShuffle: () => shuffle,
        setShuffle(value) { shuffle = value; },
        getRepeat: () => repeat,
        setRepeat(value) { repeat = value; },
        seek(fraction) { playerData.positionMs = fraction * 120000; },
        addEventListener(name, callback) { events[name] = callback; }, isPlaying: () => Boolean(playerData?.item) && !playerData.paused, getProgress: () => playerData?.positionMs ?? 0 },
      getAudioData,
      Platform: { PlaylistAPI: { getMetadata } },
      showNotification() {},
      Queue: { nextTracks },
    } },
    WebSocket: Socket,
    setTimeout(callback) { timers[timers.length] = callback; },
    setInterval(callback) { intervals[intervals.length] = callback; },
    Date: { now: () => time },
    console: { warn() {} },
  });
  open();
  return { sent, timers, intervals, events, controls,
    command(command, value) { onMessage({ data: JSON.stringify({ type: "playback", command, value }) }); },
    watchPlayback(watching) { onMessage({ data: JSON.stringify({ type: "playback-watch", watching }) }); },
    advance(ms) { time += ms; }, music(watching) { onMessage({ data: JSON.stringify({ type: "music-watch", watching }) }); }, refresh() { onMessage({ data: JSON.stringify({ type: "refresh-queue" }) }); } };
}

test("controls the local Spotify player and reports pauses and resumes, rejecting unknown commands", async () => {
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } } };
  const h = extensionHarness([], data);
  h.command("pause");
  await new Promise(setImmediate);
  assert.equal(h.sent.filter(({ type }) => type === "state").at(-1).track, null);
  h.command("play");
  await new Promise(setImmediate);
  assert.equal(h.sent.filter(({ type }) => type === "state").at(-1).track.uri, data.item.uri);
  h.command("next");
  h.command("previous");
  h.command("unknown");
  h.command("constructor");
  await new Promise(setImmediate);
  assert.deepEqual(h.controls, ["pause", "play", "next", "previous"]);
});

test("reports paused metadata, seek, volume, shuffle and repeat only while the player is watched", async () => {
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } }, paused: true, positionMs: 3000 };
  const h = extensionHarness([], data);
  assert.equal(h.sent.some(({ type }) => type === "playback-state"), false);
  h.watchPlayback(true);
  const snapshot = () => h.sent.filter(({ type }) => type === "playback-state").at(-1).state;
  assert.equal(snapshot().playing, false);
  assert.equal(snapshot().track.title, "First");
  h.command("seek", 1);
  h.command("volume", 0.3);
  h.command("shuffle");
  h.command("repeat");
  await new Promise(setImmediate);
  assert.equal(snapshot().positionMs, 1);
  assert.equal(snapshot().volume, 0.3);
  assert.equal(snapshot().shuffle, true);
  assert.equal(snapshot().repeat, 1);
  h.command("volume", 3);
  h.command("seek", -1);
  await new Promise(setImmediate);
  assert.equal(snapshot().volume, 0.3);
  assert.equal(snapshot().positionMs, 1);
  h.command("mute");
  await new Promise(setImmediate);
  assert.equal(snapshot().volume, 0);
  h.command("repeat");
  await new Promise(setImmediate);
  assert.equal(snapshot().repeat, 2);
  h.command("repeat");
  await new Promise(setImmediate);
  assert.equal(snapshot().repeat, 0);
  h.watchPlayback(false);
  const count = h.sent.length;
  h.intervals.at(-1)();
  assert.equal(h.sent.length, count);
});

function reportedQueue(nextTracks) {
  return extensionHarness(nextTracks).sent.find((message) => message.type === "queue");
}

test("keeps a newly created playlist's tracks before Spotify assigns queue ids", () => {
  const report = reportedQueue([
    { provider: "context", contextTrack: { uri: "spotify:track:first", metadata: { title: "First" } } },
    { provider: "context", contextTrack: { uri: "spotify:track:second", uid: "", metadata: { title: "Second" } } },
    { provider: "context", contextTrack: { uri: "spotify:track:third", uid: "valid_3" } },
  ]);
  assert.deepEqual(report.upcoming.map(({ uri }) => uri), ["spotify:track:first", "spotify:track:second", "spotify:track:third"]);
  assert.equal(report.upcoming[0].uid, undefined);
  assert.equal(report.upcoming[1].uid, undefined);
  assert.equal(report.upcoming[2].uid, "valid_3");
});

test("drops unplayable entries, keeps the explicit queue separate and handles autoplay", () => {
  const report = reportedQueue([
    { provider: "queue", contextTrack: { uri: "spotify:track:queued", uid: "q1" } },
    { provider: "context", contextTrack: { uri: "spotify:episode:podcast", uid: "p1" } },
    { provider: "autoplay", contextTrack: { uri: "spotify:track:next", uid: "invalid:id", metadata: { title: "a".repeat(210) } } },
  ]);
  assert.deepEqual(report.tracks.map(({ uri }) => uri), ["spotify:track:queued"]);
  assert.equal(report.upcoming.length, 1);
  assert.equal(report.upcoming[0].uid, undefined);
  assert.equal(report.upcoming[0].title.length, 200);
});


test("detects a fresh playlist when its context arrives after songchange", async () => {
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } } };
  const h = extensionHarness([], data, async () => ({ name: "Mix Work" }));
  assert.equal(h.sent.find(({ type }) => type === "state").context, null);
  h.events.songchange();
  data.context = { uri: "spotify:playlist:newlist", metadata: { context_description: "Mix Work" } };
  h.timers.at(-1)();
  assert.deepEqual(h.sent.filter(({ type }) => type === "state").at(-1).context, { uri: "spotify:playlist:newlist", name: "Mix Work" });
});

test("retries unavailable metadata without caching an empty name for the whole Spotify session", async () => {
  let requests = 0;
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } }, context: { uri: "spotify:playlist:newlist" } };
  const h = extensionHarness([], data, async () => { requests += 1; return requests === 1 ? {} : { name: "New playlist" }; });
  await new Promise(setImmediate);
  assert.equal(requests, 1);
  h.intervals[0]();
  assert.equal(requests, 1);
  h.advance(5000);
  h.intervals[0]();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(h.sent.filter(({ type }) => type === "queue").at(-1).contextName, "New playlist");
});

test("an explicit refresh retries a new playlist immediately and accepts a late player-state name", async () => {
  let requests = 0;
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } }, context: { uri: "", metadata: {} }, context_uri: "spotify:playlist:newlist" };
  const h = extensionHarness([], data, async () => { requests += 1; return {}; });
  await new Promise(setImmediate);
  h.refresh();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  data.context = { uri: "spotify:playlist:newlist", metadata: { context_description: "Mix Work" } };
  h.refresh();
  assert.equal(h.sent.filter(({ type }) => type === "queue").at(-1).contextName, "Mix Work");
});


test("music follows Spotify analysis, seeks and pauses, only while requested", async () => {
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } }, positionMs: 750 };
  let calls = 0;
  const h = extensionHarness([], data, undefined, async () => {
    calls++;
    return {
      beats: [{ start: 0 }, { start: 0.5 }, { start: 1 }],
      bars: [{ start: 0 }, { start: 1 }],
      segments: [
        { start: 0, loudness_start: -26, loudness_max: -6, timbre: [0, -60] },
        { start: 1, loudness_max: -20, timbre: [0, 120] },
      ],
    };
  });
  h.intervals[2]();
  assert.equal(calls, 0);
  h.music(true);
  await new Promise(setImmediate);
  h.intervals[2]();
  let frame = h.sent.at(-1).frame;
  assert.equal(frame.uri, "spotify:track:first");
  assert.equal(frame.beatStartMs, 500);
  // Loudness over the last 40 dB; a 20 dB rise is a strong (bass) attack; a dull timbre is bass, not treble.
  assert.equal(frame.intensity, 0.85);
  assert.equal(frame.attack, 0.8);
  assert.equal(frame.brightness, 0);
  assert.equal(frame.barStartMs, 0);
  data.positionMs = 1200;
  h.intervals[2]();
  assert.equal(h.sent.at(-1).frame.beatStartMs, 1000);
  assert.equal(h.sent.at(-1).frame.intensity, 0.5);
  assert.equal(h.sent.at(-1).frame.attack, 0);
  assert.equal(h.sent.at(-1).frame.brightness, 1);
  assert.equal(h.sent.at(-1).frame.barStartMs, 1000);
  data.positionMs = 0;
  h.intervals[2]();
  assert.equal(h.sent.at(-1).frame.beatStartMs, 0);
  data.paused = true;
  h.intervals[2]();
  assert.equal(h.sent.at(-1).frame, null);
  h.music(false);
  const sent = h.sent.length;
  h.intervals[2]();
  assert.equal(h.sent.length, sent);
  assert.equal(calls, 1);
});

test("unavailable analysis and a late response from the previous track never invent a signal", async () => {
  const data = { item: { uri: "spotify:track:first", metadata: { title: "First" } } };
  let first;
  const h = extensionHarness([], data, undefined, (uri) => uri.endsWith("first")
    ? new Promise((resolve) => { first = resolve; })
    : Promise.reject(new Error("unavailable")));
  h.music(true);
  data.item.uri = "spotify:track:second";
  h.intervals[2]();
  first({ beats: [{ start: 0 }], segments: [{ start: 0, loudness_max: -6 }] });
  await new Promise(setImmediate);
  h.intervals[2]();
  assert.equal(h.sent.at(-1).frame, null);
});
