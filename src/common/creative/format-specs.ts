/**
 * Declarative registry of creative "formats" — the visual/structural presentation
 * layer, distinct from hookStyle (the emotional angle). Single source of truth,
 * imported by both the primary Creative Team path (creative-team.service.ts) and
 * the single-agent fallback path (copy-writer.service.ts), so a format behaves
 * identically regardless of which path actually produces the copy.
 *
 * Before this registry, format-specific behaviour (meme/carousel) was two
 * hand-rolled ternaries duplicated inside creative-team.service.ts's ~1000-line
 * prompt builder, and the fallback path ignored format entirely. Adding a new
 * format: add one entry here — do not add new `if (brief.format === ...)`
 * branches to the prompt builders.
 *
 * Carousel is the one exception: its output shape (variants[0] + carouselCards[])
 * is structurally different from every other format's variants[]-only shape, so
 * it keeps its own dedicated code path in creative-team.service.ts. This registry
 * still carries carousel's metadata (label/hint/aspectRatio/skipVideo) for the
 * frontend picker and for aspect-ratio threading into image generation.
 */
import {
  HOOK_STYLES_DR,
  HOOK_STYLE_DESCRIPTIONS,
  HOOK_STYLES_MEME,
  HOOK_STYLE_DESCRIPTIONS_MEME,
  HOOK_STYLES_SCREENSHOT,
  HOOK_STYLE_DESCRIPTIONS_SCREENSHOT,
  HOOK_STYLES_POLL,
  HOOK_STYLE_DESCRIPTIONS_POLL,
} from './hook-styles';

export type FormatGroup = 'image' | 'carousel' | 'native' | 'video';
/** Shared aspect-ratio set — same 4 options for both images and video. */
export type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5';
/** @deprecated use AspectRatio — kept as an alias so existing imports don't break. */
export type VideoAspectRatio = AspectRatio;

/** Gemini imageConfig.imageSize / rough OpenAI quality tier for still images. */
export type ImageResolution = '1K' | '2K' | '4K';

/**
 * Shared across both video engines. Heygen's /v3/video-agents only accepts
 * '720p' | '1080p' | '4k' — '480p' is Higgsfield-only (several of its models,
 * e.g. seedance_2_0/seedance_2_0_mini, support it as their cheapest tier).
 * The dashboard is responsible for never offering '480p' when Heygen is the
 * selected engine — there's no backend-side rejection of it for Heygen, so
 * don't add a UI path that could send it there.
 */
export type VideoResolution = '480p' | '720p' | '1080p' | '4k';

export interface FormatSpec {
  id: string;
  label: string;
  hint: string;
  group: FormatGroup;
  aspectRatio: AspectRatio;
  skipVideo: boolean;
  variantCount: number;
  hookStyles: readonly string[];
  hookStyleDescriptions: Record<string, string>;
  /** "CREATIVE SPECS" framing paragraph — creative-team.service.ts only. */
  framingText: string;
  /**
   * Copy-structure instructions — consumed by BOTH creative-team.service.ts and
   * copy-writer.service.ts (each injects it into its own surrounding prompt shape;
   * the two prompts are structurally different, so this is the shared instruction
   * text, not a shared literal template).
   */
  copyGuidance: string;
  /**
   * True for formats whose copy is structurally different from the standard
   * hook→value→price→CTA DR shape (meme, screenshot, poll_quiz) — callers must
   * skip their own generic price/audience-stage copy instructions entirely and
   * rely on `copyGuidance` alone for structure.
   */
  customCopyShape: boolean;
  /**
   * Full override for the "b) IMAGE PROMPTS" body in creative-team.service.ts.
   * Omit to reuse the default visual-centerpiece framework (right for formats
   * where the still image is a normal product photo — most video-native formats).
   */
  imageSectionBody?: string;
  /**
   * STEP-0 preamble injected before the hookStyle-driven duration/opener/music
   * tables in the "c) VIDEO CREATIVE" section. Omit for skipVideo formats.
   */
  videoGuidance?: string;
}

const DEFAULT_FRAMING =
  'This is a PAID Meta direct response ad. The user is scrolling and has NOT asked to see this.\n' +
  'Your creative must: (1) stop the scroll in the FIRST LINE / FIRST 3 SECONDS, (2) make the value proposition crystal clear (product + benefit + price), (3) push to ONE action — tap the CTA button.';

const DEFAULT_COPY_GUIDANCE =
  'Standard direct-response structure: LINE 1 hook (scroll-stopper) → LINE 2-3 value (agitate pain or amplify desire, introduce product) → LINE 4 price + proof → LINE 5 CTA/urgency. 5-7 word headline. Button CTA ("Shop Now"/"Order Now"/"Buy Today").';

const MEME_COPY_GUIDANCE =
  '1-2 lines MAX — meme copy is short. LINE 1 = the recognizable meme/format reference (instantly relatable). LINE 2 = the product as the natural punchline or solution, feels organic not forced, MUST mention product name. 5-7 word headline (can be the punchline). cta: "Shop Now", "Order Now", "Buy Today". Short is everything — if it needs explaining, it is not a meme.';

const SCREENSHOT_COPY_GUIDANCE =
  'Copy IS a fake phone-UI conversation, not ad prose — write actual message bubbles / review text per the hookStyle spec below (chat thread, review card, or DM). 3-4 short bubbles or one review block. headline = a short caption above the screenshot (5-7 words). No emoji-stuffed "ad voice" — must read like a real screen capture.';

const POLL_QUIZ_COPY_GUIDANCE =
  'Copy is a question + exactly 2 options per the hookStyle spec below (would-you-rather or which-are-you). headline = the question itself (short). primaryText = Option A / Option B lines + one-line product tie-in. Both options must be genuinely plausible — a fake choice reads as manipulative.';

function defaultSpec(overrides: Partial<FormatSpec> & Pick<FormatSpec, 'id' | 'label' | 'hint' | 'group'>): FormatSpec {
  return {
    aspectRatio: '9:16',
    skipVideo: false,
    variantCount: 4,
    hookStyles: HOOK_STYLES_DR,
    hookStyleDescriptions: HOOK_STYLE_DESCRIPTIONS,
    framingText: DEFAULT_FRAMING,
    copyGuidance: DEFAULT_COPY_GUIDANCE,
    customCopyShape: false,
    ...overrides,
  };
}

const FORMAT_SPECS: Record<string, FormatSpec> = {
  image: defaultSpec({
    id: 'image', label: 'Image', hint: 'Single static image ad', group: 'image',
    skipVideo: true,
  }),
  video: defaultSpec({
    id: 'video', label: 'Video', hint: 'Short-form video ad', group: 'video',
    videoGuidance: '',
  }),
  meme: defaultSpec({
    id: 'meme', label: 'Meme', hint: 'Relatable, funny — strong for feed & reels virality', group: 'native',
    skipVideo: true,
    hookStyles: HOOK_STYLES_MEME,
    hookStyleDescriptions: HOOK_STYLE_DESCRIPTIONS_MEME,
    customCopyShape: true,
    framingText:
      'This is a MEME-FORMAT paid Meta ad riding a viral cultural moment. The viewer must instantly recognize the meme/trend and laugh or relate — THEN notice the brand tie-in.\n' +
      'Your creative must: (1) nail the meme format exactly so it feels native, (2) tie in the product naturally — forced product insertion kills meme ads, (3) push to ONE action — tap the CTA button.',
    copyGuidance: MEME_COPY_GUIDANCE,
  }),
  carousel: defaultSpec({
    id: 'carousel', label: 'Carousel', hint: 'Multi-slide story or grid format', group: 'carousel',
    aspectRatio: '1:1',
  }),

  // Static-image formats — pure graphics, no companion video (except studio_product_shot).
  before_after_static: defaultSpec({
    id: 'before_after_static', label: 'Before / after', hint: 'Split-screen transformation, single image', group: 'native',
    aspectRatio: '4:5', skipVideo: true,
    imageSectionBody:
      'Split-screen composition: BEFORE on left/top (the struggle, muted tones), AFTER on right/bottom (the resolution, warm tones). Same person or same symbolic subject in both halves so the transformation reads instantly. Bold text overlay bridging both halves with the hook line. Product name + price in the AFTER half. High-contrast dividing line between the two halves.',
  }),
  screenshot: defaultSpec({
    id: 'screenshot', label: 'Screenshot ad', hint: 'Fake chat / review thread — high trust, low production cost', group: 'native',
    aspectRatio: '9:16', skipVideo: true,
    hookStyles: HOOK_STYLES_SCREENSHOT,
    hookStyleDescriptions: HOOK_STYLE_DESCRIPTIONS_SCREENSHOT,
    copyGuidance: SCREENSHOT_COPY_GUIDANCE,
    customCopyShape: true,
    imageSectionBody:
      'This is a UI MOCKUP, not a photo — render an authentic-looking phone screenshot (WhatsApp thread, Instagram DM, App Store review card, or star-rating review — match the hookStyle). Real-looking message bubbles/UI chrome (status bar, app header), the exact copy text rendered inside the bubbles/card, plain neutral phone-screen background. No stock-photo elements, no product photography — the "ad" IS the screenshot.',
  }),
  quote_card: defaultSpec({
    id: 'quote_card', label: 'Quote card', hint: 'Bold text on plain background — scroll-stopping simplicity', group: 'native',
    aspectRatio: '1:1', skipVideo: true,
    imageSectionBody:
      'No product photography, no people. A single bold quote/line (the hook) in large, high-contrast sans-serif type, centered on a plain or subtly textured solid-color background. Product name + price as a small line at the bottom. The typography IS the visual centerpiece — nothing competes with it.',
  }),
  comparison_chart: defaultSpec({
    id: 'comparison_chart', label: 'Comparison chart', hint: '"Us vs. them" table — strong for considered purchases', group: 'native',
    aspectRatio: '4:5', skipVideo: true,
    imageSectionBody:
      'A two-column comparison table/chart graphic: left column = the generic/ordinary alternative, right column = this product, each row a specific differentiator (not vague claims). Checkmarks/crosses or short phrases per row. Product name + price below the chart. Clean, infographic-style layout — not a lifestyle photo.',
  }),
  stat_shock: defaultSpec({
    id: 'stat_shock', label: 'Stat shock', hint: 'One dominant, surprising number as the hero visual', group: 'native',
    aspectRatio: '1:1', skipVideo: true,
    imageSectionBody:
      'ONE large, dominant statistic or number fills 60%+ of the frame in bold type — the single most surprising fact tied to the hook. Supporting one-line context beneath it in smaller text. Product name + price as a small footer line. No competing visual elements — the number is the entire point.',
  }),
  studio_product_shot: defaultSpec({
    id: 'studio_product_shot', label: 'Studio product shot', hint: 'Clean white-background product photography', group: 'native',
    aspectRatio: '4:5', skipVideo: false,
    imageSectionBody:
      'Clean, well-lit studio product photography on a plain white or neutral-gradient background — no lifestyle scene, no dramatic centerpiece. Product shown from its most flattering angle, sharp focus, commercial-catalog quality. Headline + price as clean overlay text, not competing with the product itself.',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Clean product-only b-roll — slow rotating or macro shots of the product against a neutral studio background, no lifestyle scene, no dramatic story arc. Let the hookStyle table below still govern overall duration/pacing, but keep every shot product-centric throughout.',
  }),
  text_post: defaultSpec({
    id: 'text_post', label: 'Text post', hint: 'Looks like an organic status update — blends into the feed', group: 'native',
    aspectRatio: '1:1', skipVideo: true,
    imageSectionBody:
      'Mimic a plain organic Facebook/Instagram text-status update — plain solid-color background (or the platform\'s native status-update gradient look), no product photography, no imagery at all. Just the hook line rendered as bold centered text, exactly like a real status post. Product name mentioned only in small text at the bottom, not as a "sell" moment.',
  }),
  poll_quiz: defaultSpec({
    id: 'poll_quiz', label: 'Poll / quiz', hint: '"Which one are you?" — drives comments the algorithm rewards', group: 'native',
    aspectRatio: '1:1', skipVideo: true,
    hookStyles: HOOK_STYLES_POLL,
    hookStyleDescriptions: HOOK_STYLE_DESCRIPTIONS_POLL,
    copyGuidance: POLL_QUIZ_COPY_GUIDANCE,
    customCopyShape: true,
    imageSectionBody:
      'A two-option poll/quiz graphic: the question as a bold headline, Option A and Option B each in their own labeled half of the frame (split composition), visually distinct from each other. Product name + price as a small footer tying both options back to the product. No single dominant photo — the two-option split IS the composition.',
  }),

  // Video-native formats — cinematic b-roll + off-screen VO (no avatar), distinct
  // pacing/structure guidance only. Still images use the default centerpiece framework.
  ugc_testimonial: defaultSpec({
    id: 'ugc_testimonial', label: 'UGC-style testimonial', hint: 'Handheld, unpolished customer-testimonial feel', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Handheld, unpolished UGC aesthetic — natural lighting, slightly imperfect framing, phone-camera feel rather than cinematic gloss. Off-screen VO reads like a real customer recounting their experience, not a scripted ad. Cut on natural pauses, not hard music-timed cuts.',
  }),
  founder_to_camera: defaultSpec({
    id: 'founder_to_camera', label: 'Founder story', hint: 'Direct-response narration as if the founder is speaking (no on-screen face)', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: VO reads as a first-person founder explaining why they built this and the problem it solves — direct, personal register ("Maine yeh isliye banaya kyunki…"), not third-person ad copy. B-roll stays product/process-focused (per the no-avatar rule below), narration carries the personal framing.',
  }),
  unboxing_demo: defaultSpec({
    id: 'unboxing_demo', label: 'Unboxing / demo', hint: 'Product-in-hand reveal — kills skepticism for physical/tangible offers', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Close-up product-in-hand b-roll — unwrapping/opening/reveal motion, hands interacting with the actual product or report/deliverable. VO describes what is being revealed in real time ("Yeh khulte hi sabse pehle…"). No abstract metaphor shots — the product itself is the visual through the whole video.',
  }),
  before_after_video: defaultSpec({
    id: 'before_after_video', label: 'Before / after (video)', hint: 'Transformation arc in motion', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Two clearly distinct visual halves in sequence — the BEFORE state (muted tones, tension) transitioning into the AFTER state (warm tones, resolution) at the midpoint cut. The transition cut itself should be the most visually deliberate moment in the video.',
  }),
  day_in_life: defaultSpec({
    id: 'day_in_life', label: 'Day in the life', hint: 'Lifestyle montage — product woven into a routine', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Lifestyle montage across 3-4 everyday moments (morning routine, commute, work, evening) with the product/service woven naturally into one of them — not pitched, just present. VO is reflective/conversational, not salesy, until the CTA beat.',
  }),
  pov: defaultSpec({
    id: 'pov', label: 'POV', hint: '"POV: you just found out..." — native to how people scroll Reels', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: First-person POV camera framing throughout — as if the viewer IS the subject (hands, phone screen, first-person perspective shots). Text overlay opens with "POV:" framing the scenario. VO speaks directly to "you", present tense.',
  }),
  green_screen_reaction: defaultSpec({
    id: 'green_screen_reaction', label: 'Green-screen reaction', hint: 'Reacting to a stat, review, or claim — feels organic, not ad-like', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: Structure as a reaction to an on-screen stat/review/claim — open with the claim/stat filling the frame, then cut to reaction-style b-roll (surprise, nodding, pointing) responding to it, VO voices the reaction reasoning. Feels like organic commentary, not a produced ad.',
  }),
  skit: defaultSpec({
    id: 'skit', label: 'Skit / mini-story', hint: 'Quick scene-cut narrative with a punchline', group: 'video',
    videoGuidance:
      'FORMAT-LEVEL STRUCTURE: 3 quick scene-cut beats (setup → complication → punchline/resolution), hard cuts between each, no slow build. The final beat should land like a punchline, then cut immediately to the CTA — no lingering.',
  }),
};

/** Falls back to the 'image' spec for any unknown/legacy format string. */
export function getFormatSpec(format: string | undefined | null): FormatSpec {
  return (format && FORMAT_SPECS[format]) || FORMAT_SPECS.image;
}

export function listFormatSpecs(): FormatSpec[] {
  return Object.values(FORMAT_SPECS);
}
