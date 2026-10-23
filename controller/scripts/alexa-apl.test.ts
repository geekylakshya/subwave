import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import type { RequestEnvelope } from 'ask-sdk-model';

import type { AlexaAplResponseBuilder } from '../src/alexa/presentation.js';

const { addAlexaAplDirective, alexaAplViewportClass, createAlexaAplDataSource } =
  await import('../src/alexa/presentation.js');
const { createAlexaSkill } = await import('../src/routes/alexa.js');

const skillId = 'amzn1.ask.skill.11111111-1111-4111-8111-111111111111';

function envelope(
  request: Record<string, unknown>,
  options: {
    apl?: boolean;
    shape?: 'ROUND' | 'RECTANGLE';
    width?: number;
    height?: number;
    mode?: 'HUB' | 'TV' | 'MOBILE';
    maxAplVersion?: string;
    locale?: string;
  } = {},
): RequestEnvelope {
  const supportedInterfaces: Record<string, unknown> = { AudioPlayer: {} };
  if (options.apl) {
    supportedInterfaces['Alexa.Presentation.APL'] = {
      runtime: { maxVersion: options.maxAplVersion || '2024.3' },
    };
  }
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'SessionId.apl',
      application: { applicationId: skillId },
      user: { userId: 'amzn1.ask.account.apl' },
    },
    context: {
      System: {
        application: { applicationId: skillId },
        user: { userId: 'amzn1.ask.account.apl' },
        device: {
          deviceId: 'amzn1.ask.device.apl',
          supportedInterfaces,
        },
        apiEndpoint: 'https://api.amazonalexa.com',
      },
      Viewport: {
        shape: options.shape || 'RECTANGLE',
        mode: options.mode || 'HUB',
        pixelWidth: options.width || 1280,
        pixelHeight: options.height || 800,
      },
    },
    request: {
      locale: options.locale || 'en-IN',
      ...request,
    },
  } as unknown as RequestEnvelope;
}

const runtime = {
  getSettings: () => ({
    enabled: true,
    skillId,
    station: 'EXAMPLE STATION',
    streamMount: '/stream.mp3',
    streamUrl: 'https://radio.example/stream.mp3',
  }),
  isStreamOnline: () => true,
  nowPlaying: async () => ({
    id: 'track-1',
    title: 'Around the World',
    artist: 'Daft Punk',
    album: 'Discovery',
    artworkUrl: 'https://radio.example/cover/track-1',
  }),
  listenerFeatures: {
    moreLikeThis: async () => ({
      kind: 'ok',
      value: {
        id: 'similar-1',
        title: 'Digital Love',
        artist: 'Daft Punk',
        album: 'Discovery',
        artworkUrl: 'https://radio.example/cover/similar-1',
      },
    }),
    anotherByArtist: async () => ({
      kind: 'ok',
      value: {
        id: 'artist-1',
        title: 'Harder Better Faster Stronger',
        artist: 'Daft Punk',
        album: 'Discovery',
      },
    }),
    recentTracks: async () => [{
      id: 'recent-1', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery',
    }],
    trackDetails: async () => ({
      kind: 'ok',
      value: {
        id: 'track-1', title: 'Around the World', artist: 'Daft Punk', album: 'Discovery',
        artworkUrl: 'https://radio.example/cover/track-1', year: 2001, genre: 'Electronic', language: 'English',
      },
    }),
    currentShow: async () => ({ name: 'Night Drive', dj: 'Subwave', guests: [] }),
  } as any,
};

function handlerInput(request: RequestEnvelope) {
  return { requestEnvelope: request };
}

function askResponseTemplateLoader(): ((directory: string) => Array<{ name?: string }> | undefined) | null {
  try {
    const askBinary = realpathSync(execFileSync('which', ['ask'], { encoding: 'utf8' }).trim());
    const acdlModule = resolve(dirname(askBinary), '../../node_modules/@alexa/acdl/dist/cjs/package.js');
    const loaded = createRequire(import.meta.url)(acdlModule) as {
      loadResponseTemplatesSync?: (directory: string) => Array<{ name?: string }> | undefined;
    };
    return loaded.loadResponseTemplatesSync || null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function validateAplPackageContract(manifest: unknown, document: unknown): void {
  const manifestBody = record(manifest);
  const skillManifest = record(manifestBody.manifest);
  assert.equal(skillManifest.manifestVersion, '1.0');
  const customApi = record(record(skillManifest.apis).custom);
  assert.match(String(record(customApi.endpoint).uri), /^https:\/\//);
  const interfaces = record(customApi).interfaces as unknown[];
  assert.ok(Array.isArray(interfaces));
  assert.ok(interfaces.some(entry => record(entry).type === 'AUDIO_PLAYER'));
  const aplInterface = interfaces.find(entry => record(entry).type === 'ALEXA_PRESENTATION_APL');
  assert.ok(aplInterface);
  const viewports = record(aplInterface).supportedViewports;
  assert.ok(Array.isArray(viewports));
  for (const viewport of viewports) {
    const shape = record(viewport);
    assert.ok(['HUB', 'TV', 'MOBILE'].includes(String(shape.mode)));
    assert.ok(['ROUND', 'RECTANGLE'].includes(String(shape.shape)));
    for (const dimension of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight']) {
      assert.equal(typeof shape[dimension], 'number');
    }
  }

  const aplDocument = record(document);
  assert.equal(aplDocument.type, 'APL');
  assert.match(String(aplDocument.version), /^\d+\.\d+$/);
  const mainTemplate = record(aplDocument.mainTemplate);
  assert.deepEqual(mainTemplate.parameters, ['payload']);
  const rootItems = mainTemplate.items;
  assert.ok(Array.isArray(rootItems));
  const serialized = JSON.stringify(aplDocument);
  for (const requiredBinding of [
    "viewportClass == 'round'",
    "viewportClass == 'compact'",
    "viewportClass == 'portrait'",
    "viewportClass == 'wide'",
    'data.title',
    'data.artist',
    'data.label',
    'data.value',
  ]) {
    assert.match(serialized, new RegExp(requiredBinding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

test('APL support is optional and viewport classification is deterministic', () => {
  const round = envelope({ type: 'IntentRequest' }, { apl: true, shape: 'ROUND', width: 599, height: 599 });
  const compact = envelope({ type: 'IntentRequest' }, { apl: true, width: 800, height: 480 });
  const compactMinimum = envelope({ type: 'IntentRequest' }, { apl: true, width: 960, height: 100 });
  const mobileMedium = envelope({ type: 'IntentRequest' }, { apl: true, mode: 'MOBILE', width: 960, height: 480 });
  const portrait = envelope({ type: 'IntentRequest' }, { apl: true, width: 1000, height: 2000 });
  const portraitMinimum = envelope({ type: 'IntentRequest' }, { apl: true, mode: 'MOBILE', width: 600, height: 800 });
  const wide = envelope({ type: 'IntentRequest' }, { apl: true, width: 1920, height: 1080 });
  const tv = envelope({ type: 'IntentRequest' }, { apl: true, mode: 'TV', width: 960, height: 540 });
  const mobileLarge = envelope({ type: 'IntentRequest' }, { apl: true, mode: 'MOBILE', width: 1280, height: 800 });
  const voiceOnly = envelope({ type: 'IntentRequest' });

  assert.equal(alexaAplViewportClass(handlerInput(round)), 'round');
  assert.equal(alexaAplViewportClass(handlerInput(compact)), 'compact');
  assert.equal(alexaAplViewportClass(handlerInput(compactMinimum)), 'compact');
  assert.equal(alexaAplViewportClass(handlerInput(mobileMedium)), 'compact');
  assert.equal(alexaAplViewportClass(handlerInput(portrait)), 'portrait');
  assert.equal(alexaAplViewportClass(handlerInput(portraitMinimum)), 'portrait');
  assert.equal(alexaAplViewportClass(handlerInput(wide)), 'wide');
  assert.equal(alexaAplViewportClass(handlerInput(tv)), 'wide');
  assert.equal(alexaAplViewportClass(handlerInput(mobileLarge)), 'wide');
  assert.equal(Boolean(createAlexaAplDataSource(handlerInput(voiceOnly), {
    kind: 'status', heading: 'Status', message: 'Ready',
  }).subwaveData), true);
});

test('bounded payloads keep list/detail data visible on small screens', () => {
  const input = handlerInput(envelope({ type: 'IntentRequest' }, { apl: true, width: 800, height: 480 }));
  const list = createAlexaAplDataSource(input, {
    kind: 'list',
    heading: 'Recent tracks',
    items: [{ title: 'Track one', artist: 'Artist one', album: 'Album one' }],
  }) as any;
  assert.equal(list.subwaveData.properties.primary, 'Track one');
  assert.equal(list.subwaveData.properties.secondary, 'Artist one');

  const details = createAlexaAplDataSource(input, {
    kind: 'details',
    heading: 'Track details',
    track: { title: 'Track one', artist: 'Artist one' },
    fields: [{ label: 'Album', value: 'Unavailable' }],
  }) as any;
  assert.deepEqual(details.subwaveData.properties.items, [{ label: 'Album', value: 'Unavailable' }]);
  assert.equal(details.subwaveData.properties.message, 'Album: Unavailable');
});

test('APL package resources match the renderer contract', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../skill-package/skill.json', import.meta.url), 'utf8'));
  const documentText = readFileSync(new URL('../../skill-package/response/display/subwave/document.json', import.meta.url), 'utf8');
  const document = JSON.parse(documentText);
  validateAplPackageContract(manifest, document);
  assert.equal(document.version, '1.9');
  assert.ok(manifest.manifest.apis.custom.interfaces.some((entry: { type?: string }) => entry.type === 'ALEXA_PRESENTATION_APL'));
  assert.match(documentText, /data\.title/);
  assert.match(documentText, /data\.label/);
  assert.match(documentText, /viewportClass == 'round'/);
  assert.match(documentText, /viewportClass == 'wide'/);
  assert.match(documentText, /"height": "15%"/);
  assert.match(documentText, /"height": "65%"/);
  assert.match(documentText, /"height": "20%"/);

  const viewports = manifest.manifest.apis.custom.interfaces
    .find((entry: { type?: string }) => entry.type === 'ALEXA_PRESENTATION_APL')
    .supportedViewports as Array<{ mode: string; minWidth: number; maxWidth: number }>;
  for (const expected of [
    ['HUB', 100, 599],
    ['HUB', 960, 1279],
    ['HUB', 1280, 1920],
    ['HUB', 1920, 2560],
    ['TV', 960, 960],
    ['MOBILE', 600, 959],
    ['MOBILE', 960, 1279],
    ['MOBILE', 1280, 1920],
  ]) {
    assert.ok(viewports.some(viewport => viewport.mode === expected[0]
      && viewport.minWidth === expected[1]
      && viewport.maxWidth === expected[2]), `missing viewport ${expected.join(':')}`);
  }
});

test('ASK CLI accepts the local display response package', t => {
  const loadResponseTemplates = askResponseTemplateLoader();
  if (!loadResponseTemplates) {
    t.skip('ASK CLI is not installed in this environment');
    return;
  }
  const templates = loadResponseTemplates(resolve(process.cwd(), '../skill-package')) || [];
  assert.ok(templates.some(template => template.name === 'subwave'));
});

test('each responsive viewport branch preserves the primary visual payload', () => {
  const viewports = [
    { shape: 'ROUND' as const, width: 599, height: 599 },
    { width: 800, height: 480 },
    { width: 1000, height: 2000 },
    { width: 1920, height: 1080 },
  ];
  for (const viewport of viewports) {
    const input = handlerInput(envelope({ type: 'IntentRequest' }, { apl: true, ...viewport }));
    const list = createAlexaAplDataSource(input, {
      kind: 'list',
      heading: 'Recent tracks',
      items: [{ title: 'Track one', artist: 'Artist one', album: 'Album one' }],
    }) as any;
    const details = createAlexaAplDataSource(input, {
      kind: 'details',
      heading: 'Track details',
      track: { title: 'Track one', artist: 'Artist one' },
      fields: [{ label: 'Album', value: 'Unavailable' }],
    }) as any;
    assert.equal(list.subwaveData.properties.primary, 'Track one');
    assert.equal(list.subwaveData.properties.secondary, 'Artist one');
    assert.deepEqual(details.subwaveData.properties.items, [{ label: 'Album', value: 'Unavailable' }]);
  }
});

test('render fixtures cover every declared screen family and minimum boundary', () => {
  const fixtures = [
    { mode: 'HUB' as const, shape: 'ROUND' as const, width: 100, height: 100, view: { kind: 'status' as const, heading: 'Status', message: 'Ready' } },
    { mode: 'HUB' as const, width: 960, height: 100, view: { kind: 'list' as const, heading: 'Queue', items: [] } },
    { mode: 'MOBILE' as const, width: 600, height: 320, view: { kind: 'track' as const, heading: 'Track', track: { title: 'Track', artist: 'Artist' } } },
    { mode: 'MOBILE' as const, width: 600, height: 800, view: { kind: 'details' as const, heading: 'Details', track: { title: 'Track', artist: 'Artist' }, fields: [{ label: 'Album', value: 'Unavailable' }] } },
    { mode: 'HUB' as const, width: 960, height: 540, view: { kind: 'list' as const, heading: 'Queue', items: [{ title: 'Track', artist: 'Artist' }] } },
    { mode: 'TV' as const, width: 960, height: 540, view: { kind: 'details' as const, heading: 'Details', track: { title: 'Track', artist: 'Artist' }, fields: [{ label: 'Album', value: 'Unavailable' }] } },
  ];
  for (const fixture of fixtures) {
    let directive: unknown;
    const builder = {
      addDirective(value: unknown) {
        directive = value;
        return builder;
      },
    } as any;
    const input = handlerInput(envelope({ type: 'IntentRequest' }, { apl: true, ...fixture }));
    assert.equal(addAlexaAplDirective(input, builder, fixture.view), true);
    const rendered = record(directive);
    assert.equal(rendered.type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(record(rendered.document).src, 'doc://alexa/apl/documents/subwave');
    assert.equal(record(record(rendered.datasources).subwaveData).type, 'object');
  }
});

test('minimum-size status views keep a spoken fallback visible', () => {
  for (const [viewport, tiny] of [
    [{ shape: 'ROUND' as const, width: 100, height: 100 }, true],
    [{ width: 960, height: 100 }, true],
    [{ mode: 'MOBILE' as const, width: 600, height: 800 }, false],
  ] as const) {
    const source = createAlexaAplDataSource(
      handlerInput(envelope({ type: 'IntentRequest' }, { apl: true, ...viewport })),
      { kind: 'status', heading: 'Status', message: 'No current track is available', tone: 'warning' },
    ) as any;
    assert.equal(source.subwaveData.properties.isSmall, true);
    assert.equal(source.subwaveData.properties.isTiny, tiny);
    assert.equal(source.subwaveData.properties.message, 'No current track is available');
  }
});

test('compact and round backgrounds always have a branded fallback', () => {
  const round = envelope({ type: 'IntentRequest' }, { apl: true, shape: 'ROUND', width: 599, height: 599 });
  const source = createAlexaAplDataSource(handlerInput(round), {
    kind: 'track',
    heading: 'Now playing',
    track: {
      title: 'Track',
      artist: 'Artist',
      artworkUrl: 'https://radio.example/cover/track',
    },
  }) as any;
  const properties = source.subwaveData.properties;
  assert.equal(properties.backgroundColor, '#f3efe6');
  assert.equal(properties.backgroundImage, null);
  assert.equal(properties.station, 'SUB/WAVE');
});

test('supported non-playback intents receive one linked APL document in every locale', async () => {
  for (const locale of ['en-US', 'en-IN', 'hi-IN']) {
    const result = await createAlexaSkill(runtime).invoke(envelope({
      type: 'IntentRequest',
      requestId: `apl-${locale}`,
      timestamp: '2026-10-23T12:00:00Z',
      intent: { name: 'NowPlayingIntent', confirmationStatus: 'NONE', slots: {} },
    }, { apl: true, locale }));
    const response = result.response as any;
    assert.equal(response.directives.length, 1);
    assert.equal(response.directives[0].type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(response.directives[0].document.src, 'doc://alexa/apl/documents/subwave');
    assert.equal(response.directives[0].datasources.subwaveData.properties.station, 'EXAMPLE STATION');
    assert.match(response.outputSpeech.ssml, /<speak>/);
  }
});

test('all five listener-feature intents receive visual data after their normal result', async () => {
  const intents = [
    'MoreLikeThisIntent',
    'AnotherByArtistIntent',
    'RecentTracksIntent',
    'TrackDetailsIntent',
    'CurrentShowIntent',
  ];
  for (const name of intents) {
    const result = await createAlexaSkill({
      ...runtime,
      submitRequest: async () => ({ accepted: true, statusCode: 202, requestId: name, status: 'pending' }),
    }).invoke(envelope({
      type: 'IntentRequest',
      requestId: `apl-${name}`,
      timestamp: '2026-10-23T12:00:00Z',
      intent: {
        name,
        confirmationStatus: 'NONE',
        slots: name === 'TrackDetailsIntent' ? { detailType: { value: 'all' } } : {},
      },
    }, { apl: true }));
    const directives = (result.response as any).directives || [];
    assert.equal(directives.length, 1, name);
    assert.equal(directives[0].type, 'Alexa.Presentation.APL.RenderDocument', name);
  }
});

test('playback responses never combine AudioPlayer with APL', async () => {
  const launch = await createAlexaSkill(runtime).invoke(envelope({
    type: 'LaunchRequest',
    requestId: 'apl-launch',
    timestamp: '2026-10-23T12:00:00Z',
  }, { apl: true }));
  const response = launch.response as any;
  assert.deepEqual(response.directives.map((directive: any) => directive.type), ['AudioPlayer.Play']);

  const pause = await createAlexaSkill(runtime).invoke(envelope({
    type: 'IntentRequest',
    requestId: 'apl-pause',
    timestamp: '2026-10-23T12:00:00Z',
    intent: { name: 'AMAZON.PauseIntent', confirmationStatus: 'NONE', slots: {} },
  }, { apl: true }));
  assert.deepEqual((pause.response as any).directives.map((directive: any) => directive.type), ['AudioPlayer.Stop']);
});

test('the APL decorator is synchronous and skips unsupported devices', () => {
  let added = false;
  const builder = {
    addDirective: () => {
      added = true;
      return builder;
    },
  } as unknown as AlexaAplResponseBuilder;
  const view = { kind: 'status' as const, heading: 'Status', message: 'Ready' };
  assert.equal(addAlexaAplDirective(handlerInput(envelope({ type: 'IntentRequest' })), builder, view), false);
  assert.equal(added, false);
  assert.equal(addAlexaAplDirective(handlerInput(envelope({ type: 'IntentRequest' }, { apl: true })), builder, view), true);
  assert.equal(added, true);

  added = false;
  assert.equal(addAlexaAplDirective(
    handlerInput(envelope({ type: 'IntentRequest' }, { apl: true, maxAplVersion: '1.8' })),
    builder,
    view,
  ), false);
  assert.equal(added, false);
});
