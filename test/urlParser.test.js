import { parseMediaUrl } from "../src/utils/urlParser.js";

console.log("Running Universal URL Parser Unit Tests...\n");

// 1. YouTube Tests
const yt1 = parseMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
console.assert(
  yt1.isValid && yt1.provider === "youtube" && yt1.mediaId === "dQw4w9WgXcQ" && yt1.canonicalUrl === "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube Standard Failed"
);

const yt2 = parseMediaUrl("https://youtu.be/dQw4w9WgXcQ");
console.assert(
  yt2.isValid && yt2.provider === "youtube" && yt2.mediaId === "dQw4w9WgXcQ" && yt2.canonicalUrl === "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube Shortened Failed"
);

// YouTube share link with tracking param ?si=...
const ytShare = parseMediaUrl("https://youtu.be/dQw4w9WgXcQ?si=7qB_m7xZ-xyz");
console.assert(
  ytShare.isValid && ytShare.provider === "youtube" && ytShare.mediaId === "dQw4w9WgXcQ" && ytShare.canonicalUrl === "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube Share with Tracking Failed"
);

// YouTube share link with timestamp ?t=45
const ytTime = parseMediaUrl("https://youtu.be/dQw4w9WgXcQ?t=45");
console.assert(
  ytTime.isValid && ytTime.canonicalUrl === "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45",
  "YouTube Shortened Timestamp Failed"
);

const yt3 = parseMediaUrl("https://www.youtube.com/shorts/abcdefghijk");
console.assert(
  yt3.isValid && yt3.provider === "youtube" && yt3.mediaId === "abcdefghijk" && yt3.canonicalUrl === "https://www.youtube.com/watch?v=abcdefghijk",
  "YouTube Shorts Failed"
);

const yt4 = parseMediaUrl("https://www.youtube.com/live/abcdefghijk");
console.assert(
  yt4.isValid && yt4.provider === "youtube" && yt4.mediaId === "abcdefghijk" && yt4.canonicalUrl === "https://www.youtube.com/watch?v=abcdefghijk",
  "YouTube Live Failed"
);

// 2. Twitch Tests
const tw1 = parseMediaUrl("https://www.twitch.tv/shroud");
console.assert(tw1.isValid && tw1.provider === "twitch" && tw1.mediaId === "shroud", "Twitch Channel Failed");

const tw2 = parseMediaUrl("https://www.twitch.tv/videos/123456789");
console.assert(tw2.isValid && tw2.provider === "twitch" && tw2.mediaId === "123456789", "Twitch Video Failed");

// 3. Vimeo Tests (Standard & Unlisted)
const vimeo = parseMediaUrl("https://vimeo.com/76979871");
console.assert(vimeo.isValid && vimeo.provider === "vimeo" && vimeo.mediaId === "76979871", "Vimeo Standard Failed");

const vimeoUnlisted = parseMediaUrl("https://vimeo.com/67019023/abcdef1234");
console.assert(
  vimeoUnlisted.isValid && vimeoUnlisted.embedUrl === "https://player.vimeo.com/video/67019023?h=abcdef1234",
  "Vimeo Unlisted Privacy Hash Failed"
);

// 4. DailyMotion Tests (Standard & Title Slug)
const dm = parseMediaUrl("https://www.dailymotion.com/video/x8x123");
console.assert(dm.isValid && dm.provider === "dailymotion" && dm.mediaId === "x8x123", "DailyMotion Standard Failed");

const dmSlug = parseMediaUrl("https://www.dailymotion.com/video/x8abcdef_funny-cat-video");
console.assert(dmSlug.isValid && dmSlug.mediaId === "x8abcdef", "DailyMotion Title Slug Failed");

// 5. SoundCloud Tests
const sc = parseMediaUrl("https://soundcloud.com/artist/track-title");
console.assert(sc.isValid && sc.provider === "soundcloud", "SoundCloud Failed");

// 6. Streamable Tests
const st = parseMediaUrl("https://streamable.com/if2a1");
console.assert(st.isValid && st.provider === "streamable" && st.mediaId === "if2a1", "Streamable Failed");

// 7. HLS Live Stream Tests
const hls = parseMediaUrl("https://stream.site.com/live/index.m3u8");
console.assert(hls.isValid && hls.provider === "hls", "HLS Live Stream Failed");

// 8. Direct Video Tests
const mp4 = parseMediaUrl("https://sample.com/video.mp4");
console.assert(mp4.isValid && mp4.provider === "direct", "Direct MP4 Failed");

// 9. Bug 1 Regression Test: Invalid HTTP URLs (e.g. google.com) MUST return isValid: false
const invalidGoogle = parseMediaUrl("https://google.com");
console.assert(!invalidGoogle.isValid && invalidGoogle.provider === "unknown", "Bug 1 Fix Failed: google.com was marked valid");

const invalidReddit = parseMediaUrl("https://reddit.com/r/videos");
console.assert(!invalidReddit.isValid && invalidReddit.provider === "unknown", "Bug 1 Fix Failed: reddit.com was marked valid");

console.log("All Universal URL Parser Unit Tests Passed Successfully");
