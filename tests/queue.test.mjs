import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../workadventure.js", import.meta.url), "utf8");

function extensionHarness(nextTracks, playerData, getMetadata) {
  const sent = [];
  let open;
  let onMessage;
  const timers = [];
  const events = {};
  const intervals = [];
  let time = 10000;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    addEventListener(name, callback) { if (name === "open") open = callback; if (name === "message") onMessage = callback; }
    send(message) { sent[sent.length] = JSON.parse(message); }
  }
  runInNewContext(source, {
    window: { Spicetify: {
      Player: { data: playerData, playUri() {}, addEventListener(name, callback) { events[name] = callback; }, isPlaying: () => Boolean(playerData?.item), getProgress: () => 0 },
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
  return { sent, timers, intervals, events, advance(ms) { time += ms; }, refresh() { onMessage({ data: JSON.stringify({ type: "refresh-queue" }) }); } };
}

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
