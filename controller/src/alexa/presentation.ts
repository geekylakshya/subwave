/**
 * Synchronous, voice-first APL projection for Alexa responses.
 *
 * This module deliberately knows only about the request viewport and the
 * already-resolved response data. It must not await, query the library, or
 * touch the request pipeline. Playback responses keep their native
 * AudioPlayer directive because Alexa does not allow RenderDocument beside
 * AudioPlayer.Play/Stop in one response.
 */

import type { interfaces } from 'ask-sdk-model';
import type { HandlerInput, ResponseBuilder } from 'ask-sdk-core';

export type AlexaAplViewportClass = 'round' | 'compact' | 'portrait' | 'wide';

const ALEXA_APL_DOCUMENT_VERSION = '1.9';
const ALEXA_APL_MIN_RUNTIME_VERSION = '1.9';

export type AlexaAplInput = Pick<HandlerInput, 'requestEnvelope'>;

export interface AlexaAplTrack {
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
}

export interface AlexaAplListItem extends AlexaAplTrack {
  detail?: string | null;
}

export type AlexaAplView =
  | {
      kind: 'track';
      heading: string;
      track: AlexaAplTrack;
      supporting?: string | null;
      detail?: string | null;
    }
  | {
      kind: 'list';
      heading: string;
      items: AlexaAplListItem[];
      supporting?: string | null;
    }
  | {
      kind: 'details';
      heading: string;
      track: AlexaAplTrack;
      fields: Array<{ label: string; value: string }>;
    }
  | {
      kind: 'show';
      heading: string;
      name: string;
      dj?: string | null;
      guests?: string[];
    }
  | {
      kind: 'status';
      heading: string;
      message: string;
      tone?: 'normal' | 'success' | 'warning';
    }
  | {
      kind: 'help';
      heading: string;
      message: string;
      examples: string[];
    };

export type AlexaAplResponseBuilder = Pick<ResponseBuilder, 'addDirective'>;

interface AlexaAplTrackProperties {
  title: string;
  artist: string;
  album: string | null;
  artwork: string | null;
}

interface AlexaAplListDataItem extends AlexaAplTrackProperties {
  detail: string | null;
}

interface AlexaAplDetailDataItem {
  label: string;
  value: string;
}

interface AlexaAplDataProperties {
  view: AlexaAplView['kind'];
  heading: string;
  primary: string | null;
  secondary: string | null;
  tertiary: string | null;
  message: string | null;
  examples: string[];
  items: Array<AlexaAplListDataItem | AlexaAplDetailDataItem>;
  artwork: string | null;
  viewportWidth: number;
  viewportHeight: number;
  isSmall: boolean;
  isTiny: boolean;
  station: string;
  viewportClass: AlexaAplViewportClass;
  aplVersion: string;
  tone: 'normal' | 'success' | 'warning';
  backgroundColor: string;
  backgroundImage: string | null;
  textColor: string;
  messageColor: string;
  mutedColor: string;
  accentColor: string;
}

export interface AlexaAplDataSource {
  subwaveData: {
    type: 'object';
    objectId: 'subwave';
    properties: AlexaAplDataProperties;
  };
}

export const ALEXA_APL_DOCUMENT_URI = 'doc://alexa/apl/documents/subwave';
export const ALEXA_APL_DOCUMENT_TOKEN = 'subwave-apl';

function viewport(input: AlexaAplInput): interfaces.viewport.ViewportState {
  return input.requestEnvelope?.context.Viewport || {};
}

function versionRank(value: string): number | null {
  const match = /^(\d{1,4})\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 1000 + Number(match[2]);
}

export function supportsAlexaApl(input: AlexaAplInput): boolean {
  const apl = input.requestEnvelope?.context.System.device?.supportedInterfaces?.['Alexa.Presentation.APL'];
  if (!apl) return false;
  const maxVersion = apl.runtime?.maxVersion;
  if (!maxVersion) return true;
  const maxRank = versionRank(maxVersion);
  const minimumRank = versionRank(ALEXA_APL_MIN_RUNTIME_VERSION);
  return maxRank == null || minimumRank == null || maxRank >= minimumRank;
}

export function alexaAplViewportClass(input: AlexaAplInput): AlexaAplViewportClass {
  const current = viewport(input);
  const mode = current.mode || 'AUTO';
  if (mode === 'TV') return 'wide';
  if (current.shape === 'ROUND') return 'round';

  const width = Number(current.currentPixelWidth || current.pixelWidth || 0);
  const height = Number(current.currentPixelHeight || current.pixelHeight || 0);
  if (height > width * 1.2) return 'portrait';
  if (width > 0 && width < 960) return 'compact';
  if (height > 0 && height < 600) return 'compact';
  return 'wide';
}

function clean(value: unknown, maxLength = 4000): string | null {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function trackProperties(track: AlexaAplTrack | undefined): AlexaAplTrackProperties {
  return {
    title: clean(track?.title, 160) || 'Unknown track',
    artist: clean(track?.artist, 120) || 'Unknown artist',
    album: clean(track?.album, 160),
    artwork: clean(track?.artworkUrl, 1024),
  };
}

function viewProperties(view: AlexaAplView): Omit<AlexaAplDataProperties, 'viewportWidth' | 'viewportHeight' | 'isSmall' | 'isTiny' | 'station' | 'viewportClass' | 'aplVersion' | 'tone' | 'backgroundColor' | 'backgroundImage' | 'textColor' | 'messageColor' | 'mutedColor' | 'accentColor'> {
  const base: Omit<AlexaAplDataProperties, 'viewportWidth' | 'viewportHeight' | 'isSmall' | 'isTiny' | 'station' | 'viewportClass' | 'aplVersion' | 'tone' | 'backgroundColor' | 'backgroundImage' | 'textColor' | 'messageColor' | 'mutedColor' | 'accentColor'> = {
    view: view.kind,
    heading: clean(view.heading, 100) || 'SUB/WAVE',
    primary: null,
    secondary: null,
    tertiary: null,
    message: null,
    examples: [],
    items: [],
    artwork: null,
  };

  if (view.kind === 'track') {
    const track = trackProperties(view.track);
    base.primary = track.title;
    base.secondary = track.artist;
    base.tertiary = clean(view.detail) || clean(view.supporting) || track.album;
    base.artwork = track.artwork;
    return base;
  }

  if (view.kind === 'list') {
    base.message = clean(view.supporting, 4000);
    base.items = view.items.slice(0, 3).map(item => ({
      ...trackProperties(item),
      detail: clean(item.detail, 240),
    }));
    const [first] = base.items as AlexaAplListDataItem[];
    base.primary = first?.title || null;
    base.secondary = first?.artist || null;
    base.tertiary = first?.detail || first?.album || null;
    base.artwork = first?.artwork || null;
    return base;
  }

  if (view.kind === 'details') {
    const track = trackProperties(view.track);
    base.primary = track.title;
    base.secondary = track.artist;
    base.tertiary = track.album;
    base.message = view.fields
      .slice(0, 6)
      .map(field => `${clean(field.label, 80) || 'Detail'}: ${clean(field.value, 240) || 'Unavailable'}`)
      .join('\n');
    base.items = view.fields.slice(0, 6).map(field => ({
      label: clean(field.label, 80) || 'Detail',
      value: clean(field.value, 240) || 'Unavailable',
    }));
    base.artwork = track.artwork;
    return base;
  }

  if (view.kind === 'show') {
    base.primary = clean(view.name, 160) || 'Current show unavailable';
    base.secondary = clean(view.dj, 120);
    base.message = view.guests?.length
      ? `Guests: ${view.guests.slice(0, 3).map(guest => clean(guest, 120)).filter(Boolean).join(', ')}`
      : null;
    return base;
  }

  if (view.kind === 'help') {
    base.message = clean(view.message, 4000);
    base.examples = view.examples
      .slice(0, 4)
      .map(example => clean(example, 180))
      .filter((example): example is string => Boolean(example));
    return base;
  }

  base.message = clean(view.message, 4000);
  return base;
}

export function createAlexaAplDataSource(
  input: AlexaAplInput,
  view: AlexaAplView,
  station = 'SUB/WAVE',
): AlexaAplDataSource {
  const viewportClass = alexaAplViewportClass(input);
  const currentViewport = viewport(input);
  const viewportWidth = Number(currentViewport.currentPixelWidth || currentViewport.pixelWidth || 0);
  const viewportHeight = Number(currentViewport.currentPixelHeight || currentViewport.pixelHeight || 0);
  const properties = viewProperties(view);
  const artwork = typeof properties.artwork === 'string' ? properties.artwork : null;
  const useArtworkBackground = viewportClass === 'wide' && Boolean(artwork);
  const tone = view.kind === 'status' ? view.tone || 'normal' : 'normal';
  const textColor = viewportClass === 'round' || viewportClass === 'compact' ? '#161412' : '#ece6dc';
  const messageColor = tone === 'warning' ? '#d94b2a' : tone === 'success' ? '#4fa77a' : textColor;

  return {
    subwaveData: {
      type: 'object',
      objectId: 'subwave',
      properties: {
        ...properties,
        viewportWidth,
        viewportHeight,
        isSmall: Math.min(viewportWidth || Infinity, viewportHeight || Infinity) < 420
          || (viewportClass === 'portrait' && viewportHeight > 0 && viewportHeight < 1000),
        isTiny: Math.min(viewportWidth || Infinity, viewportHeight || Infinity) < 160,
        station: clean(station, 80) || 'SUB/WAVE',
        viewportClass,
        aplVersion: ALEXA_APL_DOCUMENT_VERSION,
        tone,
        backgroundColor: viewportClass === 'round' || viewportClass === 'compact'
          ? '#f3efe6'
          : '#100e0c',
        backgroundImage: useArtworkBackground ? artwork : null,
        textColor,
        messageColor,
        mutedColor: viewportClass === 'round' || viewportClass === 'compact'
          ? '#6d675e'
          : '#c1c0bd',
        accentColor: '#d94b2a',
      },
    },
  };
}

/**
 * Add a visual response without introducing asynchronous work. Callers must
 * invoke this only after their normal voice/business result is complete.
 */
export function addAlexaAplDirective(
  input: AlexaAplInput,
  responseBuilder: AlexaAplResponseBuilder,
  view: AlexaAplView,
  station = 'SUB/WAVE',
): boolean {
  if (!supportsAlexaApl(input)) return false;
  const directive: interfaces.alexa.presentation.apl.RenderDocumentDirective = {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: ALEXA_APL_DOCUMENT_TOKEN,
    document: {
      type: 'Link',
      src: ALEXA_APL_DOCUMENT_URI,
    },
    datasources: createAlexaAplDataSource(input, view, station),
  };
  responseBuilder.addDirective(directive);
  return true;
}
