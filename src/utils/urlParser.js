// Universal Media URL Parser
// Parses raw media URLs and extracts provider, mediaId, and embed metadata

const YOUTUBE_REGEX =
  /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;

const TWITCH_CHANNEL_REGEX = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]{4,25})\/?$/;
const TWITCH_VIDEO_REGEX = /^https?:\/\/(?:www\.)?twitch\.tv\/videos\/(\d+)\/?$/;
const TWITCH_CLIP_REGEX = /^https?:\/\/(?:clips\.twitch\.tv\/|www\.twitch\.tv\/[a-zA-Z0-9_]+\/clip\/)([a-zA-Z0-9_-]+)\/?$/;

const VIMEO_REGEX = /(?:vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/[^\/]*\/videos\/|album\/\d+\/video\/|video\/|)(\d+))(?:[\/]([a-zA-Z0-9]+))?/;

const DAILYMOTION_REGEX = /(?:dailymotion\.com\/(?:video|embed\/video)\/|dai\.ly\/)([a-zA-Z0-9]+)(?:_[^?&]+)?/;

const SOUNDCLOUD_REGEX = /^https?:\/\/(?:www\.)?soundcloud\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/;

const STREAMABLE_REGEX = /^https?:\/\/(?:www\.)?streamable\.com\/([a-zA-Z0-9]+)/;

const HLS_STREAM_REGEX = /\.m3u8(\?.*)?$/i;

const DIRECT_VIDEO_EXTENSIONS = /\.(mp4|webm|ogv|mov)(\?.*)?$/i;

export function parseMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { isValid: false, provider: "unknown", mediaId: null, embedUrl: null, rawUrl: "" };
  }

  const trimmedUrl = rawUrl.trim();

  // 1. Check YouTube
  const ytMatch = trimmedUrl.match(YOUTUBE_REGEX);
  if (ytMatch && ytMatch[1]) {
    const videoId = ytMatch[1];
    return {
      isValid: true,
      provider: "youtube",
      mediaId: videoId,
      embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1`,
      rawUrl: trimmedUrl,
    };
  }

  // 2. Check Twitch Video / VOD
  const twitchVidMatch = trimmedUrl.match(TWITCH_VIDEO_REGEX);
  if (twitchVidMatch && twitchVidMatch[1]) {
    return {
      isValid: true,
      provider: "twitch",
      subType: "video",
      mediaId: twitchVidMatch[1],
      embedUrl: trimmedUrl,
      rawUrl: trimmedUrl,
    };
  }

  // 3. Check Twitch Clip
  const twitchClipMatch = trimmedUrl.match(TWITCH_CLIP_REGEX);
  if (twitchClipMatch && twitchClipMatch[1]) {
    return {
      isValid: true,
      provider: "twitch",
      subType: "clip",
      mediaId: twitchClipMatch[1],
      embedUrl: trimmedUrl,
      rawUrl: trimmedUrl,
    };
  }

  // 4. Check Twitch Live Channel
  const twitchChannelMatch = trimmedUrl.match(TWITCH_CHANNEL_REGEX);
  if (twitchChannelMatch && twitchChannelMatch[1]) {
    const channelName = twitchChannelMatch[1].toLowerCase();
    const reservedPages = ["directory", "downloads", "p", "videos", "subscriptions", "settings"];
    if (!reservedPages.includes(channelName)) {
      return {
        isValid: true,
        provider: "twitch",
        subType: "channel",
        mediaId: channelName,
        embedUrl: trimmedUrl,
        rawUrl: trimmedUrl,
      };
    }
  }

  // 5. Check Vimeo (with unlisted video hash support)
  const vimeoMatch = trimmedUrl.match(VIMEO_REGEX);
  if (vimeoMatch && vimeoMatch[1]) {
    const videoId = vimeoMatch[1];
    const unlistedHash = vimeoMatch[2];
    const embedUrl = unlistedHash
      ? `https://player.vimeo.com/video/${videoId}?h=${unlistedHash}`
      : `https://player.vimeo.com/video/${videoId}`;

    return {
      isValid: true,
      provider: "vimeo",
      mediaId: videoId,
      embedUrl,
      rawUrl: trimmedUrl,
    };
  }

  // 6. Check DailyMotion (with title slug support)
  const dmMatch = trimmedUrl.match(DAILYMOTION_REGEX);
  if (dmMatch && dmMatch[1]) {
    const videoId = dmMatch[1];
    return {
      isValid: true,
      provider: "dailymotion",
      mediaId: videoId,
      embedUrl: `https://www.dailymotion.com/embed/video/${videoId}`,
      rawUrl: trimmedUrl,
    };
  }

  // 7. Check SoundCloud
  if (SOUNDCLOUD_REGEX.test(trimmedUrl)) {
    return {
      isValid: true,
      provider: "soundcloud",
      mediaId: trimmedUrl,
      embedUrl: trimmedUrl,
      rawUrl: trimmedUrl,
    };
  }

  // 8. Check Streamable
  const streamableMatch = trimmedUrl.match(STREAMABLE_REGEX);
  if (streamableMatch && streamableMatch[1]) {
    return {
      isValid: true,
      provider: "streamable",
      mediaId: streamableMatch[1],
      embedUrl: `https://streamable.com/e/${streamableMatch[1]}`,
      rawUrl: trimmedUrl,
    };
  }

  // 9. Check HLS Streams (.m3u8)
  if (HLS_STREAM_REGEX.test(trimmedUrl)) {
    return {
      isValid: true,
      provider: "hls",
      mediaId: trimmedUrl,
      embedUrl: trimmedUrl,
      rawUrl: trimmedUrl,
    };
  }

  // 10. Check Direct Video Files (MP4, WebM, OGV, MOV, blob:)
  // Fixed Bug 1: Removed trimmedUrl.startsWith("http") so non-video HTTP links fall through to invalid
  if (DIRECT_VIDEO_EXTENSIONS.test(trimmedUrl) || trimmedUrl.startsWith("blob:")) {
    return {
      isValid: true,
      provider: "direct",
      mediaId: trimmedUrl,
      embedUrl: trimmedUrl,
      rawUrl: trimmedUrl,
    };
  }

  return {
    isValid: false,
    provider: "unknown",
    mediaId: null,
    embedUrl: null,
    rawUrl: trimmedUrl,
  };
}
