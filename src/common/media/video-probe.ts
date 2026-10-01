import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 30_000;

export type VideoRatio = '9:16' | '4:5' | '1:1' | '16:9';
const RATIOS: Record<VideoRatio, number> = {
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '16:9': 16 / 9,
};

/** Nearest placement ratio for any frame size — a 3:4 video counts as 4:5, 2:1 as 16:9. */
export function nearestVideoRatio(width: number, height: number): VideoRatio {
  const actual = width / height;
  return (Object.keys(RATIOS) as VideoRatio[]).sort(
    (a, b) =>
      Math.abs(Math.log(actual / RATIOS[a])) -
      Math.abs(Math.log(actual / RATIOS[b])),
  )[0];
}

/**
 * Displayed width/height from ffprobe JSON. Phone footage is often stored
 * landscape with a 90° rotation flag, so a rotated stream swaps dimensions.
 */
export function parseProbeDimensions(
  json: string,
): { width: number; height: number } | undefined {
  const stream = JSON.parse(json)?.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!width || !height) return undefined;
  const rotation = Number(
    stream.side_data_list?.find((d: any) => d.rotation !== undefined)
      ?.rotation ??
      stream.tags?.rotate ??
      0,
  );
  return Math.abs(rotation) % 180 === 90
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Measure a video's displayed aspect ratio from its URL (ffprobe only reads
 * the container header). Returns undefined if probing fails — callers fall
 * back to the uploader's tag.
 */
export async function probeVideoRatio(
  url: string,
): Promise<VideoRatio | undefined> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:stream_side_data=rotation:stream_tags=rotate',
      '-of',
      'json',
      url,
    ],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const dims = parseProbeDimensions(stdout);
  return dims ? nearestVideoRatio(dims.width, dims.height) : undefined;
}
