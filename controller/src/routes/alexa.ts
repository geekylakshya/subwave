import express from 'express';
import { SkillBuilders, escapeXmlCharacters, type HandlerInput } from 'ask-sdk-core';
import type { Response as AlexaResponse } from 'ask-sdk-model';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import * as settings from '../settings.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { queue } from '../broadcast/queue.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  alexaStreamOptions,
  alexaStreamUrl,
  effectiveAlexaStreamMount,
} from '../alexa/stream.js';
import {
  createAlexaStreamToken,
  DEFAULT_ALEXA_TOKEN_TTL_HOURS,
} from '../alexa/token.js';
import { alexaPatchSchema } from '../schemas/settings.js';
import { listenerRequestSchema } from '../schemas/request.js';
import { alexaIdentityKey } from '../broadcast/request-ledger.js';
import {
  audioPlayerMetadata,
  etaSpeech,
  messages,
  trackSpeech,
  type AlexaPresentationTrack,
} from '../alexa/experience.js';
import { previewAlexaRequest, type AlexaRequestCandidate } from '../alexa/request-preview.js';
import {
  createAlexaListenerFeatureService,
  verifiedCandidateFor,
  verifiedRequestText,
  type AlexaCurrentShow,
  type AlexaListenerFeatureService,
  type AlexaListenerTrack,
  type AlexaTrackDetails,
  type AlexaVerifiedCandidate,
} from '../alexa/listener-features.js';
import {
  getLatestAlexaRequestStatus,
  cancelLatestAlexaRequest,
  replaceLatestAlexaRequest,
  submitListenerRequest,
  type ListenerRequestStatus,
} from './request.js';
import { addAlexaAplDirective, type AlexaAplTrack, type AlexaAplView } from '../alexa/presentation.js';

const router = express.Router();
const ALEXA_SKILL_ID_RE = /^amzn1\.ask\.skill\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AlexaSubmitResult = {
  accepted: true;
  statusCode: 202;
  requestId: string;
  status: 'pending';
} | {
  accepted: false;
  statusCode: number;
  message?: string;
  error?: string;
  retryAfter?: number;
};

export interface AlexaRuntime {
  getSettings: () => {
    enabled: boolean;
    skillId: string;
    station: string;
    streamUrl: string;
    streamMount?: string;
    listenerAuth?: boolean;
    listenerPassword?: string;
    tokenTtlSeconds?: number;
  };
  isStreamOnline: () => boolean;
  nowPlaying?: () => Promise<AlexaTrack | null> | AlexaTrack | null;
  upcoming?: () => Promise<AlexaTrack[]> | AlexaTrack[];
  previous?: () => Promise<AlexaTrack | null> | AlexaTrack | null;
  submitRequest?: (
    text: string,
    userId: string,
    verifiedCandidate?: AlexaVerifiedCandidate,
    personId?: string,
  ) => Promise<AlexaSubmitResult>;
  latestRequestStatus?: (identity: string) => Promise<ListenerRequestStatus | null>;
  cancelRequest?: (identity: string) => Promise<ListenerRequestStatus | null>;
  replaceRequest?: (identity: string, text: string) => Promise<AlexaSubmitResult>;
  previewRequest?: (text: string) => Promise<AlexaRequestCandidate[]>;
  listenerFeatures?: AlexaListenerFeatureService;
}

export interface AlexaTrack extends AlexaPresentationTrack {
  title: string;
  artist: string;
}

export interface AlexaConnectionCheck {
  id: 'site-url' | 'skill' | 'listener-access' | 'stream' | 'webhook';
  label: string;
  ok: boolean;
  message: string;
}

export interface AlexaConnectionTestResult {
  ok: boolean;
  checks: AlexaConnectionCheck[];
  testedAt: string;
}

export interface AlexaConnectionTestDraft {
  enabled: boolean;
  skillId: string;
  streamMount: string;
  tokenTtlHours?: number;
}

function configuredSiteUrl(): string {
  return (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
}

function defaultRuntime(): AlexaRuntime {
  const siteUrl = configuredSiteUrl();
  const toAlexaTrack = (track: any): AlexaTrack | null => {
    const title = String(track?.title || '').trim();
    const artist = String(track?.artist || '').trim();
    if (!title || !artist) return null;
    const id = String(track?.id || track?.subsonic_id || '').trim() || null;
    return {
      id,
      title,
      artist,
      album: String(track?.album || '').trim() || null,
      artworkUrl: id && siteUrl ? `${siteUrl}/cover/${encodeURIComponent(id)}` : null,
    };
  };
  return {
    getSettings: () => {
      const current = settings.get();
      const streamMount = effectiveAlexaStreamMount(current.alexa?.streamMount, current.stream);
      return {
        enabled: current.alexa?.enabled === true,
        skillId: typeof current.alexa?.skillId === 'string' ? current.alexa.skillId : '',
        station: current.station || 'SUB/WAVE',
        streamMount,
        streamUrl: alexaStreamUrl(siteUrl, streamMount),
        listenerAuth: current.privacy?.listenerAuth === true,
        listenerPassword: current.privacy?.password || '',
        tokenTtlSeconds: (current.alexa?.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS) * 3600,
      };
    },
    isStreamOnline: () => getStreamStatus().online,
    nowPlaying: async () => {
      const track = await queue.getNowPlaying();
      return toAlexaTrack(track);
    },
    upcoming: () => queue.upcoming
      .map(item => toAlexaTrack(item.track))
      .filter((track): track is AlexaTrack => track !== null),
    previous: () => toAlexaTrack(queue.history[0]?.track),
    submitRequest: (text, userId, verifiedCandidate, personId) => {
      const identity = personId
        ? `person:${personId}`
        : alexaIdentityKey(userId || 'unknown');
      return submitListenerRequest({
        text,
        name: '',
        ip: `alexa:${identity}`,
        source: 'alexa',
        alexaIdentity: identity,
        verifiedCandidate,
      }).then(result => result.accepted
        ? { accepted: true, statusCode: 202 as const, requestId: result.requestId, status: 'pending' as const }
        : result);
    },
    latestRequestStatus: identity => getLatestAlexaRequestStatus(identity),
    cancelRequest: identity => cancelLatestAlexaRequest(identity),
    replaceRequest: (identity, text) => replaceLatestAlexaRequest(identity, text).then(result => result.accepted
      ? { accepted: true, statusCode: 202 as const, requestId: result.requestId, status: 'pending' as const }
      : result),
    previewRequest: previewAlexaRequest,
    listenerFeatures: createAlexaListenerFeatureService(),
  };
}

function validPublicSiteUrl(siteUrl: string): boolean {
  try {
    const parsed = new URL(siteUrl);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && parsed.pathname === '/';
  } catch {
    return false;
  }
}

async function closeProbe(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The probe has already answered; an aborted live stream body is expected.
  }
}

/**
 * Probe the direct Alexa setup from the station's public edge.
 *
 * The webhook probe deliberately sends an unsigned Alexa-shaped request. A
 * healthy endpoint rejects that request with HTTP 400 during Alexa signature
 * verification; that proves the public route is reachable without pretending
 * that SUB/WAVE can forge an Alexa request signature.
 */
export async function testAlexaConnection(
  runtime: AlexaRuntime = defaultRuntime(),
  fetcher: typeof fetch = fetch,
  draft?: AlexaConnectionTestDraft,
): Promise<AlexaConnectionTestResult> {
  const siteUrl = configuredSiteUrl();
  const saved = runtime.getSettings();
  const current = draft
    ? {
        ...saved,
        enabled: draft.enabled,
        skillId: draft.skillId.trim(),
        streamMount: draft.streamMount,
        streamUrl: alexaStreamUrl(siteUrl, draft.streamMount),
        tokenTtlSeconds: (draft.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS) * 3600,
      }
    : saved;
  const siteOk = validPublicSiteUrl(siteUrl);
  const skillOk = !current.enabled || ALEXA_SKILL_ID_RE.test(current.skillId);
  const listenerOk = current.listenerAuth !== true
    || Boolean(current.listenerPassword && (current.tokenTtlSeconds || 0) > 0);
  const webhookProbeDeferred = draft?.enabled === true && saved.enabled !== true;
  const playbackRuntime: AlexaRuntime = {
    getSettings: () => current,
    isStreamOnline: runtime.isStreamOnline,
  };
  const streamUrl = siteUrl
    ? playbackStreamUrl(playbackRuntime)
    : current.streamUrl;
  const webhookUrl = siteUrl ? `${siteUrl}/api/alexa` : '';
  const checks: AlexaConnectionCheck[] = [
    {
      id: 'site-url',
      label: 'Public URL',
      ok: siteOk,
      message: siteOk
        ? `${siteUrl} is a valid HTTPS origin.`
        : 'SITE_URL must be a public HTTPS origin without a path, query, or hash.',
    },
    {
      id: 'skill',
      label: 'Skill configuration',
      ok: skillOk,
      message: skillOk
        ? current.enabled
          ? 'Direct Alexa skill is enabled and has a valid Skill ID format.'
          : 'Direct Alexa skill is disabled; endpoint checks can still be tested.'
        : 'Enter the complete Alexa Skill ID in the amzn1.ask.skill.<uuid> format.',
    },
    {
      id: 'listener-access',
      label: 'Public listener access',
      ok: listenerOk,
      message: listenerOk
        ? current.listenerAuth === true
          ? 'Listener authentication is enabled; Alexa will use a temporary signed stream URL.'
          : 'The stream is not password-protected.'
        : 'Listener authentication is enabled but no signing secret is available.',
    },
  ];

  if (!siteOk || !streamUrl) {
    checks.push({
      id: 'stream',
      label: 'Public stream',
      ok: false,
      message: 'Skipped because the public station URL is not configured correctly.',
    });
  } else {
    try {
      const response = await fetcher(streamUrl, {
        headers: { Range: 'bytes=0-1' },
        signal: AbortSignal.timeout(8_000),
      });
      const contentType = response.headers.get('content-type') || '';
      const httpOk = response.status >= 200 && response.status < 300;
      const audioOk = /audio\//i.test(contentType)
        || /application\/(?:octet-stream|ogg)/i.test(contentType);
      await closeProbe(response);
      const online = runtime.isStreamOnline();
      checks.push({
        id: 'stream',
        label: 'Public stream',
        ok: online && httpOk && audioOk,
        message: !online
          ? 'The controller reports that the station is offline.'
          : !httpOk
            ? `The stream returned HTTP ${response.status}.`
            : !audioOk
              ? `The stream returned an unexpected content type: ${contentType || 'unknown'}.`
              : 'The public stream is online and returns audio.',
      });
    } catch (error) {
      checks.push({
        id: 'stream',
        label: 'Public stream',
        ok: false,
        message: `Could not reach the public stream: ${error instanceof Error ? error.message : 'request failed'}.`,
      });
    }
  }

  if (webhookProbeDeferred) {
    checks.push({
      id: 'webhook',
      label: 'Alexa webhook',
      ok: true,
      message: 'Deferred until the enabled direct skill settings are saved; then test the public webhook again.',
    });
  } else if (!siteOk || !webhookUrl) {
    checks.push({
      id: 'webhook',
      label: 'Alexa webhook',
      ok: false,
      message: 'Skipped because the public station URL is not configured correctly.',
    });
  } else {
    try {
      const response = await fetcher(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0',
          session: { new: true, sessionId: 'subwave-connection-test', application: { applicationId: current.skillId } },
          context: { System: { application: { applicationId: current.skillId } } },
          request: { type: 'LaunchRequest', requestId: 'subwave-connection-test', locale: 'en-US', timestamp: new Date().toISOString() },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      const body = await response.text();
      const expectedSignatureRejection = response.status === 400
        && /verification|signature/i.test(body);
      checks.push({
        id: 'webhook',
        label: 'Alexa webhook',
        ok: expectedSignatureRejection,
        message: expectedSignatureRejection
          ? 'The public endpoint is reachable and is validating Alexa requests.'
          : response.status === 404
            ? 'The public endpoint returned 404. Check the Alexa webhook path and that the direct skill is enabled.'
            : `The public endpoint returned HTTP ${response.status}; expected Alexa signature validation (HTTP 400).`,
      });
    } catch (error) {
      checks.push({
        id: 'webhook',
        label: 'Alexa webhook',
        ok: false,
        message: `Could not reach the public endpoint: ${error instanceof Error ? error.message : 'request failed'}.`,
      });
    }
  }

  return {
    ok: checks.every(check => check.ok),
    checks,
    testedAt: new Date().toISOString(),
  };
}

function stationName(runtime: AlexaRuntime): string {
  return runtime.getSettings().station.trim() || 'SUB/WAVE';
}

function inputLocale(input: HandlerInput): string {
  return String(input.requestEnvelope?.request?.locale || 'en-IN');
}

function offlineResponse(input: HandlerInput, station = 'SUB/WAVE') {
  const copy = messages(inputLocale(input));
  return requestSpeech(input, copy.offline, {
    kind: 'status',
    heading: station,
    message: copy.offline,
    tone: 'warning',
  }, station);
}

function playbackStreamUrl(runtime: AlexaRuntime): string {
  const current = runtime.getSettings();
  if (!current.streamUrl) return '';
  if (current.listenerAuth !== true) return current.streamUrl;

  const mount = current.streamMount || '/stream.mp3';
  const token = createAlexaStreamToken(
    current.listenerPassword || '',
    mount,
    current.tokenTtlSeconds || DEFAULT_ALEXA_TOKEN_TTL_HOURS * 3600,
  );
  if (!token) return '';
  const separator = current.streamUrl.includes('?') ? '&' : '?';
  return `${current.streamUrl}${separator}auth=${encodeURIComponent(token)}`;
}

async function playResponse(input: HandlerInput, runtime: AlexaRuntime, opening: string) {
  const station = stationName(runtime);
  const streamUrl = playbackStreamUrl(runtime);
  if (!runtime.isStreamOnline() || !streamUrl) return offlineResponse(input, station);

  let track: AlexaTrack | null = null;
  try {
    track = runtime.nowPlaying ? await runtime.nowPlaying() : null;
  } catch {
    // Metadata is optional. Do not prevent live playback when the catalogue is unavailable.
  }
  const response = input.responseBuilder
    .speak(`${escapeXmlCharacters(opening)} ${escapeXmlCharacters(station)}.`)
    .addDirective({
      type: 'AudioPlayer.Play',
      playBehavior: 'REPLACE_ALL',
      audioItem: {
        stream: {
          url: streamUrl,
          token: 'subwave-live-stream',
          offsetInMilliseconds: 0,
        },
        metadata: audioPlayerMetadata(track, station),
      },
    });
  return response.withShouldEndSession(true).getResponse();
}

function stopResponse(input: HandlerInput, message: string) {
  return input.responseBuilder
    .speak(message)
    .addAudioPlayerStopDirective()
    .withShouldEndSession(true)
    .getResponse();
}

function helpResponse(input: HandlerInput, station = 'SUB/WAVE') {
  const responseBuilder = input.responseBuilder
    .speak(messages(inputLocale(input)).help)
    .withShouldEndSession(false);
  addAlexaAplDirective(input, responseBuilder, {
    kind: 'help',
    heading: station,
    message: messages(inputLocale(input)).help,
    examples: ['Ask what is playing', 'Request a song', 'Ask for request status'],
  }, station);
  return responseBuilder.getResponse();
}

function intentHandler(names: readonly string[], handle: (input: HandlerInput) => AlexaResponse | Promise<AlexaResponse>) {
  return {
    canHandle: (input: HandlerInput) =>
      input.requestEnvelope.request.type === 'IntentRequest' &&
      names.includes(input.requestEnvelope.request.intent?.name),
    handle,
  };
}

function alexaUserId(input: HandlerInput): string {
  return String(
    input.requestEnvelope?.session?.user?.userId
      || input.requestEnvelope?.context?.System?.user?.userId
      || '',
  ).trim();
}

function alexaPersonId(input: HandlerInput): string {
  return String(input.requestEnvelope?.context?.System?.person?.personId || '').trim();
}

// Person IDs are stable for Alexa's person-aware requests. When Alexa does not
// provide one, keep the existing skill-scoped account fallback: the ledger
// stores only its salted, non-reversible identity key.
function alexaRequestIdentity(input: HandlerInput): string {
  const personId = alexaPersonId(input);
  return personId ? `person:${personId}` : alexaIdentityKey(alexaUserId(input) || 'unknown');
}

function listenerFeatures(runtime: AlexaRuntime): AlexaListenerFeatureService {
  return runtime.listenerFeatures || createAlexaListenerFeatureService();
}

function featureTrack(track: AlexaListenerTrack): AlexaTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    artworkUrl: track.artworkUrl || null,
  };
}

function requestSpeech(
  input: HandlerInput,
  text: string,
  view?: AlexaAplView,
  station = 'SUB/WAVE',
) {
  const responseBuilder = input.responseBuilder
    .speak(text)
    .withShouldEndSession(true);
  if (view) addAlexaAplDirective(input, responseBuilder, view, station);
  return responseBuilder.getResponse();
}

function aplTrack(track: AlexaPresentationTrack): AlexaAplTrack {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album || null,
    artworkUrl: track.artworkUrl || null,
  };
}

function aplStatus(
  heading: string,
  message: string,
  tone: 'normal' | 'success' | 'warning' = 'normal',
): AlexaAplView {
  return { kind: 'status', heading, message, tone };
}

function dynamicSpeech(value: string | null | undefined, fallback: string): string {
  return value ? escapeXmlCharacters(value) : fallback;
}

function sessionAttributes(input: HandlerInput): Record<string, unknown> {
  return input.attributesManager?.getSessionAttributes?.() || {};
}

function saveSessionAttributes(input: HandlerInput, attributes: Record<string, unknown>): void {
  input.attributesManager?.setSessionAttributes?.(attributes);
}

function isRequestCandidate(value: unknown): value is AlexaRequestCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AlexaRequestCandidate>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.artist === 'string';
}

function requestCandidates(input: HandlerInput): AlexaRequestCandidate[] {
  const candidates = sessionAttributes(input).alexaRequestCandidates;
  return Array.isArray(candidates) ? candidates.filter(isRequestCandidate).slice(0, 3) : [];
}

function clearRequestClarification(input: HandlerInput): void {
  const attributes = sessionAttributes(input);
  delete attributes.alexaRequestCandidates;
  delete attributes.alexaRequestText;
  saveSessionAttributes(input, attributes);
}

function candidateTrack(candidate: AlexaRequestCandidate): AlexaTrack {
  return {
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album || null,
    artworkUrl: candidate.artworkUrl || null,
  };
}

function clarificationResponse(
  input: HandlerInput,
  runtime: AlexaRuntime,
  candidate: AlexaRequestCandidate,
  remaining: AlexaRequestCandidate[],
) {
  const copy = messages(inputLocale(input));
  const attributes = sessionAttributes(input);
  attributes.alexaRequestCandidates = [candidate, ...remaining];
  saveSessionAttributes(input, attributes);
  const track = candidateTrack(candidate);
  const response = input.responseBuilder
    .speak(copy.candidate(trackSpeech(track)))
    .reprompt(copy.candidateReprompt)
    .withShouldEndSession(false);
  addAlexaAplDirective(input, response, {
    kind: 'track',
    heading: 'Confirm request',
    track: aplTrack(track),
    supporting: 'Say yes to request this track or no to hear another match.',
  }, stationName(runtime));
  return response.getResponse();
}

async function nowPlayingResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const track = runtime.nowPlaying
    ? await runtime.nowPlaying()
    : await defaultRuntime().nowPlaying!();
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    track ? copy.current(trackSpeech(track)) : copy.noCurrent,
    track
      ? { kind: 'track', heading: 'Now playing', track: aplTrack(track) }
      : aplStatus('Now playing', copy.noCurrent, 'warning'),
    stationName(runtime),
  );
}

async function upcomingResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const tracks = runtime.upcoming
    ? await runtime.upcoming()
    : await defaultRuntime().upcoming!();
  const next = tracks.find(track => track.title.trim() && track.artist.trim());
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    next ? copy.next(trackSpeech(next)) : copy.noNext,
    next
      ? { kind: 'track', heading: 'Up next', track: aplTrack(next) }
      : aplStatus('Up next', copy.noNext, 'warning'),
    stationName(runtime),
  );
}

async function previousResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const track = runtime.previous
    ? await runtime.previous()
    : await defaultRuntime().previous!();
  const copy = messages(inputLocale(input));
  return requestSpeech(
    input,
    track ? copy.previous(trackSpeech(track)) : copy.noPrevious,
    track
      ? { kind: 'track', heading: 'Previous track', track: aplTrack(track) }
      : aplStatus('Previous track', copy.noPrevious, 'warning'),
    stationName(runtime),
  );
}

async function queuePreviewResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const tracks = runtime.upcoming
    ? await runtime.upcoming()
    : await defaultRuntime().upcoming!();
  const copy = messages(inputLocale(input));
  const selected = tracks.filter(track => track.title.trim() && track.artist.trim()).slice(0, 3);
  return requestSpeech(
    input,
    selected.length ? copy.nextMany(selected.map(trackSpeech).join(', ')) : copy.noNext,
    selected.length
      ? {
          kind: 'list',
          heading: 'Queue preview',
          items: selected.map(aplTrack),
        }
      : aplStatus('Queue preview', copy.noNext, 'warning'),
    stationName(runtime),
  );
}

type AlexaDetailType = 'album' | 'artist' | 'year' | 'genre' | 'language' | 'all';

function detailType(input: HandlerInput): AlexaDetailType {
  const request = input.requestEnvelope.request;
  const value = String((request.type === 'IntentRequest' ? request.intent?.slots?.detailType?.value : '') || '')
    .trim().toLocaleLowerCase();
  if (value === 'album' || value === 'artist' || value === 'year' || value === 'genre' || value === 'language') {
    return value;
  }
  return 'all';
}

function detailLabels(locale: string | null | undefined): { unavailable: string; all: string; labels: Record<AlexaDetailType, string> } {
  if (String(locale || 'en-IN') === 'hi-IN') {
    return {
      unavailable: 'उपलब्ध नहीं',
      all: 'सारी जानकारी',
      labels: { album: 'album', artist: 'artist', year: 'year', genre: 'genre', language: 'language', all: 'सारी जानकारी' },
    };
  }
  return {
    unavailable: 'unavailable',
    all: 'all details',
    labels: { album: 'album', artist: 'artist', year: 'year', genre: 'genre', language: 'language', all: 'all details' },
  };
}

function detailEntries(
  details: AlexaTrackDetails,
  requested: AlexaDetailType,
  locale: string | null | undefined,
): Array<{ label: string; value: string }> {
  const labels = detailLabels(locale);
  const values: Record<Exclude<AlexaDetailType, 'all'>, string | null> = {
    album: details.album,
    artist: details.artist,
    year: details.year == null ? null : String(details.year),
    genre: details.genre,
    language: details.language,
  };
  const keys: Array<Exclude<AlexaDetailType, 'all'>> = requested === 'all'
    ? ['album', 'artist', 'year', 'genre', 'language']
    : [requested];
  return keys.map(key => ({
    label: labels.labels[key],
    value: values[key] || labels.unavailable,
  }));
}

function detailFields(details: AlexaTrackDetails, requested: AlexaDetailType, locale: string | null | undefined): string {
  return detailEntries(details, requested, locale)
    .map(entry => `${entry.label} "${escapeXmlCharacters(entry.value)}"`)
    .join(', ');
}

function detailFieldValues(
  details: AlexaTrackDetails,
  requested: AlexaDetailType,
  locale: string | null | undefined,
): Array<{ label: string; value: string }> {
  return detailEntries(details, requested, locale);
}

async function listenerFeatureRequestResponse(
  input: HandlerInput,
  runtime: AlexaRuntime,
  kind: 'moreLikeThis' | 'anotherByArtist',
) {
  const copy = messages(inputLocale(input));
  let result;
  try {
    result = kind === 'moreLikeThis'
      ? await listenerFeatures(runtime).moreLikeThis()
      : await listenerFeatures(runtime).anotherByArtist();
  } catch {
    return requestSpeech(input, copy.featureFailed, aplStatus('Request', copy.featureFailed, 'warning'), stationName(runtime));
  }
  if (result.kind === 'no-current') return requestSpeech(input, copy.noCurrent, aplStatus('Request', copy.noCurrent, 'warning'), stationName(runtime));
  if (result.kind === 'no-match') return requestSpeech(input, copy.featureNoMatch, aplStatus('Request', copy.featureNoMatch, 'warning'), stationName(runtime));

  const candidate = result.value;
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const requestText = verifiedRequestText(candidate);
  const verified = verifiedCandidateFor(candidate);
  let submitted: AlexaSubmitResult;
  try {
    submitted = runtime.submitRequest
      ? await runtime.submitRequest(requestText, userId, verified, personId)
      : await defaultRuntime().submitRequest!(requestText, userId, verified, personId);
  } catch {
    return requestSpeech(input, copy.featureFailed, aplStatus('Request', copy.featureFailed, 'warning'), stationName(runtime));
  }
  if (!submitted.accepted) {
    const message = dynamicSpeech(submitted.message || submitted.error, copy.featureFailed);
    return requestSpeech(input, message, aplStatus('Request', message, 'warning'), stationName(runtime));
  }
  return requestSpeech(
    input,
    kind === 'moreLikeThis'
      ? copy.moreLikeThis(trackSpeech(featureTrack(candidate)))
      : copy.anotherByArtist(escapeXmlCharacters(candidate.artist)),
    {
      kind: 'track',
      heading: kind === 'moreLikeThis' ? 'More like this' : 'Another by this artist',
      track: aplTrack(featureTrack(candidate)),
      supporting: 'The request was sent to the booth.',
    },
    stationName(runtime),
  );
}

async function recentTracksResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  try {
    const tracks = await listenerFeatures(runtime).recentTracks();
    return requestSpeech(input, tracks.length
      ? copy.recent(tracks.map(track => trackSpeech(featureTrack(track))).join(', '))
      : copy.recentEmpty,
    tracks.length
      ? { kind: 'list', heading: 'Recently played', items: tracks.map(track => aplTrack(featureTrack(track))) }
      : aplStatus('Recently played', copy.recentEmpty, 'warning'),
    stationName(runtime));
  } catch {
    return requestSpeech(input, copy.recentEmpty, aplStatus('Recently played', copy.recentEmpty, 'warning'), stationName(runtime));
  }
}

async function trackDetailsResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  let result;
  try {
    result = await listenerFeatures(runtime).trackDetails();
  } catch {
    return requestSpeech(input, copy.featureFailed, aplStatus('Track details', copy.featureFailed, 'warning'), stationName(runtime));
  }
  if (result.kind === 'no-current') return requestSpeech(input, copy.noCurrent, aplStatus('Track details', copy.noCurrent, 'warning'), stationName(runtime));
  if (result.kind === 'no-match') return requestSpeech(input, copy.featureNoMatch, aplStatus('Track details', copy.featureNoMatch, 'warning'), stationName(runtime));
  const requested = detailType(input);
  const labels = detailLabels(inputLocale(input));
  const details = result.value;
  return requestSpeech(
    input,
    copy.details(
      escapeXmlCharacters(details.title),
      labels.labels[requested],
      detailFields(details, requested, inputLocale(input)),
    ),
    {
      kind: 'details',
      heading: labels.labels[requested],
      track: aplTrack(details),
      fields: detailFieldValues(details, requested, inputLocale(input)),
    },
    stationName(runtime),
  );
}

async function currentShowResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  let show: AlexaCurrentShow | null = null;
  try {
    show = await listenerFeatures(runtime).currentShow();
  } catch {
    // A show lookup is informational; use the same grounded no-show response
    // when schedule state is unavailable instead of inventing a programme.
  }
  if (!show?.name) {
    const message = copy.noShow(show?.dj ? escapeXmlCharacters(show.dj) : null);
    return requestSpeech(input, message, aplStatus('Current show', message, 'warning'), stationName(runtime));
  }
  const dj = dynamicSpeech(show.dj, 'the DJ');
  const guests = (Array.isArray(show.guests) ? show.guests : [])
    .map(guest => escapeXmlCharacters(guest)).join(', ');
  return requestSpeech(input, copy.currentShow(escapeXmlCharacters(show.name), dj, guests), {
    kind: 'show',
    heading: 'Current show',
    name: show.name,
    dj: show.dj,
    guests: show.guests,
  }, stationName(runtime));
}

async function requestSongResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const request = input.requestEnvelope.request;
  const rawText = String((request.type === 'IntentRequest' ? request.intent?.slots?.requestText?.value : '') || '').trim();
  const parsed = listenerRequestSchema.safeParse({ text: rawText, name: '' });
  const copy = messages(inputLocale(input));
  clearRequestClarification(input);
  if (!parsed.success) {
    return requestSpeech(input, copy.requestPrompt, aplStatus('Song request', copy.requestPrompt, 'warning'), stationName(runtime));
  }
  if (runtime.previewRequest) {
    try {
      const candidates = await runtime.previewRequest(parsed.data.text);
      if (candidates.length > 1) {
        return clarificationResponse(input, runtime, candidates[0], candidates.slice(1));
      }
    } catch {
      // Preview is an optional voice convenience. The normal request pipeline
      // remains authoritative when the catalogue search is unavailable.
    }
  }
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const result = runtime.submitRequest
    ? await runtime.submitRequest(parsed.data.text, userId, undefined, personId)
    : await defaultRuntime().submitRequest!(parsed.data.text, userId, undefined, personId);
  if (result.accepted) {
    return requestSpeech(input, copy.requestAccepted, aplStatus('Song request', copy.requestAccepted, 'success'), stationName(runtime));
  }
  const message = dynamicSpeech(result.message || result.error, copy.requestFailed);
  return requestSpeech(input, message, aplStatus('Song request', message, 'warning'), stationName(runtime));
}

async function confirmationResponse(input: HandlerInput, runtime: AlexaRuntime, confirmed: boolean) {
  const candidates = requestCandidates(input);
  if (!candidates.length) return helpResponse(input, stationName(runtime));
  const copy = messages(inputLocale(input));
  if (!confirmed) {
    const [, ...remaining] = candidates;
    if (!remaining.length) {
      clearRequestClarification(input);
      return requestSpeech(input, copy.candidateNo, aplStatus('Song request', copy.candidateNo), stationName(runtime));
    }
    const [next, ...rest] = remaining;
    return clarificationResponse(input, runtime, next, rest);
  }

  const selected = candidates[0];
  clearRequestClarification(input);
  const userId = alexaUserId(input) || 'unknown';
  const personId = alexaPersonId(input) || undefined;
  const text = `play "${selected.title}" by "${selected.artist}"`;
  const result = runtime.submitRequest
    ? await runtime.submitRequest(text, userId, undefined, personId)
    : await defaultRuntime().submitRequest!(text, userId, undefined, personId);
  const message = result.accepted ? copy.requestAccepted : dynamicSpeech(result.message || result.error, copy.requestFailed);
  return requestSpeech(input, message, aplStatus('Song request', message, result.accepted ? 'success' : 'warning'), stationName(runtime));
}

function statusSpeech(status: ListenerRequestStatus | null, locale?: string | null): string {
  const copy = messages(locale);
  if (!status) return copy.statusEmpty;
  const title = status.track?.title ? ` for ${escapeXmlCharacters(status.track.title)}` : '';
  const trackTitle = dynamicSpeech(status.track?.title, 'your song');
  switch (status.phase) {
    case 'queued':
      return copy.requestQueued(
        trackTitle,
        status.queuePosition ?? null,
        etaSpeech(status.etaSeconds, locale),
      );
    case 'playing':
      return copy.requestPlaying(trackTitle);
    case 'finished':
      return copy.requestFinished(trackTitle);
    case 'cancelled':
      return copy.requestCancelled(trackTitle);
    case 'interrupted':
      return copy.requestInterrupted;
    case 'failed':
      return dynamicSpeech(status.message, copy.requestFailedStatus);
    case 'resolved':
      return status.ack ? dynamicSpeech(status.ack, copy.requestFailedStatus) : copy.requestResolved(title);
    case 'pending':
    default:
      return copy.requestPending;
  }
}

async function requestStatusResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const identity = alexaRequestIdentity(input);
  const status = runtime.latestRequestStatus
    ? await runtime.latestRequestStatus(identity)
    : await defaultRuntime().latestRequestStatus!(identity);
  return requestSpeech(
    input,
    statusSpeech(status, inputLocale(input)),
    aplStatus('Request status', statusSpeech(status, inputLocale(input))),
    stationName(runtime),
  );
}

async function cancelRequestResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const identity = alexaRequestIdentity(input);
  const status = runtime.cancelRequest
    ? await runtime.cancelRequest(identity)
    : await defaultRuntime().cancelRequest!(identity);
  const copy = messages(inputLocale(input));
  if (!status) return requestSpeech(input, copy.cancelEmpty, aplStatus('Cancel request', copy.cancelEmpty, 'warning'), stationName(runtime));
  if (status.phase === 'cancelled') {
    const message = copy.cancelSuccess(dynamicSpeech(status.track?.title, 'song'));
    return requestSpeech(input, message, aplStatus('Cancel request', message, 'success'), stationName(runtime));
  }
  return requestSpeech(input, copy.cancelTooLate, aplStatus('Cancel request', copy.cancelTooLate, 'warning'), stationName(runtime));
}

async function replaceRequestResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const request = input.requestEnvelope.request;
  const rawText = String((request.type === 'IntentRequest' ? request.intent?.slots?.requestText?.value : '') || '').trim();
  const parsed = listenerRequestSchema.safeParse({ text: rawText, name: '' });
  const copy = messages(inputLocale(input));
  if (!parsed.success) return requestSpeech(input, copy.replacePrompt, aplStatus('Replace request', copy.replacePrompt, 'warning'), stationName(runtime));
  const identity = alexaRequestIdentity(input);
  const result = runtime.replaceRequest
    ? await runtime.replaceRequest(identity, parsed.data.text)
    : await defaultRuntime().replaceRequest!(identity, parsed.data.text);
  const message = result.accepted ? copy.replaceAccepted : dynamicSpeech(result.message || result.error, copy.requestFailed);
  return requestSpeech(
    input,
    message,
    aplStatus('Replace request', message, result.accepted ? 'success' : 'warning'),
    stationName(runtime),
  );
}

async function stationStatusResponse(input: HandlerInput, runtime: AlexaRuntime) {
  const copy = messages(inputLocale(input));
  const online = runtime.isStreamOnline();
  return requestSpeech(
    input,
    online ? copy.stationOnline : copy.stationOffline,
    aplStatus('Station status', online ? copy.stationOnline : copy.stationOffline, online ? 'success' : 'warning'),
    stationName(runtime),
  );
}

/**
 * Build the official Alexa Custom Skill SDK dispatcher.
 *
 * The runtime is injected so this public behavior can be tested without an
 * Icecast process and so every request observes the current station name and
 * settings rather than a value captured at controller startup.
 */
export function createAlexaSkill(runtime: AlexaRuntime = defaultRuntime()) {
  const configured = runtime.getSettings();
  const builder = SkillBuilders.custom().withSkillId(configured.skillId || '__disabled__');

  return builder
    .addRequestHandler('LaunchRequest', (input: HandlerInput) => playResponse(input, runtime, messages(inputLocale(input)).starting))
    .addRequestHandlers(
      intentHandler(['RequestSongIntent'], input => requestSongResponse(input, runtime)),
      intentHandler(['AMAZON.YesIntent'], input => confirmationResponse(input, runtime, true)),
      intentHandler(['AMAZON.NoIntent'], input => confirmationResponse(input, runtime, false)),
      intentHandler(['RequestStatusIntent'], input => requestStatusResponse(input, runtime)),
      intentHandler(['CancelRequestIntent'], input => cancelRequestResponse(input, runtime)),
      intentHandler(['ReplaceRequestIntent'], input => replaceRequestResponse(input, runtime)),
      intentHandler(['NowPlayingIntent', 'WhatIsPlayingIntent', 'CurrentSongIntent'], input =>
        nowPlayingResponse(input, runtime)),
      intentHandler(['PreviousTrackIntent'], input => previousResponse(input, runtime)),
      intentHandler(['UpcomingIntent', 'NextSongIntent', 'WhatIsNextIntent'], input =>
        upcomingResponse(input, runtime)),
      intentHandler(['QueuePreviewIntent'], input => queuePreviewResponse(input, runtime)),
      intentHandler(['MoreLikeThisIntent'], input => listenerFeatureRequestResponse(input, runtime, 'moreLikeThis')),
      intentHandler(['AnotherByArtistIntent'], input => listenerFeatureRequestResponse(input, runtime, 'anotherByArtist')),
      intentHandler(['RecentTracksIntent'], input => recentTracksResponse(input, runtime)),
      intentHandler(['TrackDetailsIntent'], input => trackDetailsResponse(input, runtime)),
      intentHandler(['CurrentShowIntent'], input => currentShowResponse(input, runtime)),
      intentHandler(['StationStatusIntent'], input => stationStatusResponse(input, runtime)),
      intentHandler(['StartRadioIntent', 'PlayRadioIntent'], input =>
        playResponse(input, runtime, messages(inputLocale(input)).starting)),
      intentHandler(['AMAZON.ResumeIntent'], input =>
        playResponse(input, runtime, messages(inputLocale(input)).resuming)),
      intentHandler(['AMAZON.PauseIntent'], input =>
        stopResponse(input, messages(inputLocale(input)).paused)),
      intentHandler(['AMAZON.StopIntent'], input =>
        stopResponse(input, messages(inputLocale(input)).stopped)),
      intentHandler(['AMAZON.CancelIntent'], input => cancelRequestResponse(input, runtime)),
      intentHandler(['AMAZON.HelpIntent'], (input: HandlerInput) =>
        helpResponse(input, stationName(runtime))),
      intentHandler(['AMAZON.FallbackIntent'], (input: HandlerInput) =>
        helpResponse(input, stationName(runtime))),
      {
        canHandle: (input: HandlerInput) => input.requestEnvelope.request.type === 'SessionEndedRequest',
        handle: () => ({}),
      },
      intentHandler(['AMAZON.NavigateHomeIntent'], (input: HandlerInput) =>
        stopResponse(input, messages(inputLocale(input)).stopped)),
      {
        canHandle: (input: HandlerInput) => input.requestEnvelope.request.type === 'IntentRequest',
        handle: (input: HandlerInput) => helpResponse(input, stationName(runtime)),
      },
    )
    .addErrorHandler(
      () => true,
      (input: HandlerInput) => {
        const message = messages(inputLocale(input)).error;
        return requestSpeech(input, message, aplStatus('Error', message, 'warning'), stationName(runtime));
      },
    )
    .create();
}

function runAdapter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const runtime = defaultRuntime();
  const adapterHandlers = new ExpressAdapter(createAlexaSkill(runtime)).getRequestHandlers();
  let index = 0;
  const run: express.NextFunction = (error?: unknown) => {
    if (error) return next(error);
    const handler = adapterHandlers[index++];
    if (!handler) return next();
    void handler(req, res, run);
  };
  run();
}

router.post('/alexa', (req, res, next) => {
  const current = defaultRuntime().getSettings();
  if (!current.enabled || !current.skillId) {
    return res.status(404).json({ error: 'Alexa integration is disabled' });
  }
  if (!current.streamUrl) {
    return res.status(503).json({ error: 'Alexa requires SITE_URL to point to the public station URL' });
  }
  return runAdapter(req, res, next);
});

router.get('/alexa/connection', requireAdmin, (_req, res) => {
  const current = settings.get();
  const siteUrl = configuredSiteUrl();
  const streamMount = effectiveAlexaStreamMount(current.alexa?.streamMount, current.stream);
  res.json({
    station: current.station || 'SUB/WAVE',
    stationDescription: current.stationDescription || '',
    siteUrl,
    webhookUrl: siteUrl ? `${siteUrl}/api/alexa` : '',
    streamMount,
    streamUrl: alexaStreamUrl(siteUrl, streamMount),
    streamOptions: alexaStreamOptions(current.stream),
    listenerAuth: current.privacy?.listenerAuth === true,
    directSkill: {
      enabled: current.alexa?.enabled === true,
      skillId: typeof current.alexa?.skillId === 'string' ? current.alexa.skillId : '',
      tokenTtlHours: current.alexa?.tokenTtlHours || DEFAULT_ALEXA_TOKEN_TTL_HOURS,
    },
  });
});

// This route shares the Alexa router with the raw-body skill webhook. The
// router is mounted before the controller-wide JSON parser so Amazon's
// signature verification sees the original bytes; parse this small admin-only
// draft explicitly instead of letting it fall through as an empty object.
router.post('/alexa/connection/test', requireAdmin, express.json({ limit: '10kb' }), async (req, res) => {
  try {
    const saved = defaultRuntime().getSettings();
    const parsed = alexaPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid Alexa draft settings',
      });
    }
    const draft: AlexaConnectionTestDraft = {
      enabled: parsed.data.enabled ?? saved.enabled,
      skillId: parsed.data.skillId ?? saved.skillId,
      streamMount: parsed.data.streamMount ?? saved.streamMount ?? '/stream.mp3',
      tokenTtlHours: parsed.data.tokenTtlHours ?? Math.round((saved.tokenTtlSeconds || DEFAULT_ALEXA_TOKEN_TTL_HOURS * 3600) / 3600),
    };
    return res.json(await testAlexaConnection(undefined, undefined, draft));
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Alexa connection test failed' });
  }
});

export { router };
