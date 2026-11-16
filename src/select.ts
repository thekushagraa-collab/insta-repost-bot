// Decides which old video goes out next.
import type { IgMedia } from "./instagram";
import type { BotState } from "./state";

/** After this many failed attempts a video is skipped for good (it is listed in the inventory report). */
export const MAX_FAILURES = 3;

export type Rng = () => number;

export function isVideo(media: IgMedia): boolean {
  return media.media_type === "VIDEO";
}

/** A video can be reposted only if Instagram gives us its file (media_url). */
export function isRepostable(media: IgMedia): boolean {
  return isVideo(media) && typeof media.media_url === "string" && media.media_url.length > 0;
}

export function remainingCandidates(media: readonly IgMedia[], state: BotState): IgMedia[] {
  return media.filter(
    (item) =>
      isRepostable(item) && !state.posted[item.id] && (state.failures[item.id]?.count ?? 0) < MAX_FAILURES,
  );
}

export function pickRandomUnposted(media: readonly IgMedia[], state: BotState, rng: Rng = Math.random): IgMedia | null {
  const candidates = remainingCandidates(media, state);
  if (candidates.length === 0) return null;
  const index = Math.min(Math.floor(rng() * candidates.length), candidates.length - 1);
  return candidates[index] ?? null;
}

export interface LibrarySummary {
  totalPosts: number;
  videos: number;
  posted: number;
  remaining: number;
  /** Videos Instagram will not hand over (usually licensed music). */
  blocked: IgMedia[];
  /** Videos that failed MAX_FAILURES times. */
  givenUp: IgMedia[];
}

export function summarizeLibrary(media: readonly IgMedia[], state: BotState): LibrarySummary {
  const videos = media.filter(isVideo);
  return {
    totalPosts: media.length,
    videos: videos.length,
    posted: videos.filter((item) => state.posted[item.id]).length,
    remaining: remainingCandidates(media, state).length,
    blocked: videos.filter((item) => !isRepostable(item)),
    givenUp: videos.filter(
      (item) => isRepostable(item) && !state.posted[item.id] && (state.failures[item.id]?.count ?? 0) >= MAX_FAILURES,
    ),
  };
}
