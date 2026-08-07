import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  BASELINE_SCHEMA_VERSION,
  runBaselinePipeline,
  writeBaselineArtifact,
} from '../src/baseline.js';
import { BrowserConfig } from '../src/browsers.js';
import { launchTest } from '../src/index.js';
import type { BrowserName } from '../src/types.js';
import { cleanupTestDirectory } from './helpers.js';
import {
  createStaticServer,
  fixturesDir,
  listenServer,
  shutdownServer,
} from './testServer.js';

const browsers: BrowserName[] = BrowserConfig.getBrowsers();
const packageVersion = (
  JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version: string;
  }
).version;
let baseUrl: string;
let server: Server;

beforeAll(async () => {
  server = createStaticServer({ fixturesDirPath: fixturesDir('baseline') });
  baseUrl = await listenServer(server);
});

afterAll(async () => {
  await shutdownServer(server);
});

describe.each(browsers)('Baseline pipeline artifacts (%s)', browser => {
  test.each([
    ['enabled', true, true],
    ['disabled', false, false],
    ['omitted', undefined, false],
  ])(
    'writes artifacts when baseline is %s',
    async (_case, baseline, enabled) => {
      const result = await launchTest({
        baseline,
        browser,
        url: `${baseUrl}/index.html`,
      });
      if (!result.success) throw new Error(result.error);
      try {
        const baselinePath = path.join(result.resultsPath, 'baseline');
        expect(fs.existsSync(baselinePath)).toBe(enabled);
        if (enabled) {
          expect(fs.existsSync(path.join(baselinePath, 'meta.json'))).toBe(
            true,
          );
        }
      } finally {
        cleanupTestDirectory(result.testId);
      }
    },
    60000,
  );

  test('writes external and live inline CSS sources from the detection pass', async () => {
    const result = await launchTest({
      baseline: true,
      browser,
      url: `${baseUrl}/index.html`,
    });
    if (!result.success) {
      throw new Error(result.error);
    }

    try {
      const sources = JSON.parse(
        fs.readFileSync(
          path.join(
            result.resultsPath,
            'baseline',
            'detection',
            'css-sources.json',
          ),
          'utf8',
        ),
      ) as Array<{ css: string; file: string }>;

      expect(sources.map(source => source.file)).toEqual([
        `${baseUrl}/styles.css`,
        `${baseUrl}/index.html (inline style #1)`,
        `${baseUrl}/index.html (inline style #2)`,
      ]);
      expect(sources[0].css).toContain('display: flex');
      expect(sources[1].css).toContain('color: green');
      expect(sources[2].css).toBe('.dynamic { display: grid; }');
    } finally {
      cleanupTestDirectory(result.testId);
    }
  }, 60000);
});

test('the pipeline writes consolidated CSS sources and isolates performance artifacts', async () => {
  fs.mkdirSync(path.resolve('results'), { recursive: true });
  const resultsPath = fs.mkdtempSync(
    path.join(process.cwd(), 'results', 'baseline-isolation-'),
  );
  const harPath = path.join(resultsPath, 'pageload.har');
  const metricsPath = path.join(resultsPath, 'metrics.json');
  const har = JSON.stringify({
    log: {
      entries: [
        {
          request: { url: 'https://example.com/external.css' },
          response: {
            content: {
              encoding: undefined,
              mimeType: 'text/css',
              text: '.external { display: grid; }',
            },
          },
        },
      ],
    },
  });
  const metrics = '{"firstContentfulPaint":123}';
  fs.writeFileSync(harPath, har);
  fs.writeFileSync(metricsPath, metrics);

  try {
    await runBaselinePipeline({
      resultsPath,
      runDetectionPass: async () => ({
        inlineCSSSources: [
          {
            css: '.inline { color: green; }',
            file: 'https://example.com (inline style #1)',
          },
        ],
      }),
      url: 'https://example.com',
    });

    const meta = JSON.parse(
      fs.readFileSync(path.join(resultsPath, 'baseline', 'meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta).toEqual({
      schemaVersion: BASELINE_SCHEMA_VERSION,
      telescopeVersion: packageVersion,
      timestamp: expect.any(String),
      url: 'https://example.com',
    });
    expect(new Date(meta.timestamp as string).toISOString()).toBe(
      meta.timestamp,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(resultsPath, 'baseline', 'detection', 'css-sources.json'),
          'utf8',
        ),
      ),
    ).toEqual([
      {
        css: '.external { display: grid; }',
        file: 'https://example.com/external.css',
      },
      {
        css: '.inline { color: green; }',
        file: 'https://example.com (inline style #1)',
      },
    ]);
    expect(fs.readFileSync(harPath, 'utf8')).toBe(har);
    expect(fs.readFileSync(metricsPath, 'utf8')).toBe(metrics);
  } finally {
    fs.rmSync(resultsPath, { recursive: true, force: true });
  }
});

test('writeBaselineArtifact round-trips content and blocks path escapes', () => {
  fs.mkdirSync(path.resolve('results'), { recursive: true });
  const resultsPath = fs.mkdtempSync(
    path.join(process.cwd(), 'results', 'baseline-artifact-'),
  );

  try {
    const artifact = { detected: ['grid', 'flexbox'] };
    writeBaselineArtifact(resultsPath, 'detection/example.json', artifact);

    const written = JSON.parse(
      fs.readFileSync(
        path.join(resultsPath, 'baseline', 'detection', 'example.json'),
        'utf8',
      ),
    ) as unknown;
    expect(written).toEqual(artifact);

    expect(() =>
      writeBaselineArtifact(resultsPath, '../outside.json', {}),
    ).toThrow('Invalid baseline artifact path');
  } finally {
    fs.rmSync(resultsPath, { recursive: true, force: true });
  }
});

test('the pipeline preserves external CSS sources when inline collection fails', async () => {
  fs.mkdirSync(path.resolve('results'), { recursive: true });
  const resultsPath = fs.mkdtempSync(
    path.join(process.cwd(), 'results', 'baseline-detection-error-'),
  );
  const error = new Error(
    'page.goto failed at https://username:password@example.com/reset/path-token?token=secret#fragment and HTTPS://example.net/another-secret',
  );
  error.name =
    'DetectionError at HTTPS://example.org/name-secret?credential=secret';
  const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fs.writeFileSync(
    path.join(resultsPath, 'pageload.har'),
    JSON.stringify({
      log: {
        entries: [
          {
            request: { url: 'https://example.com/external.css' },
            response: {
              content: {
                mimeType: 'text/css',
                text: '.external {}',
              },
            },
          },
        ],
      },
    }),
  );

  try {
    await runBaselinePipeline({
      resultsPath,
      runDetectionPass: () => Promise.reject(error),
      url: 'https://example.com',
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(resultsPath, 'baseline', 'detection', 'css-sources.json'),
          'utf8',
        ),
      ),
    ).toEqual([
      {
        css: '.external {}',
        file: 'https://example.com/external.css',
      },
    ]);
    expect(warningSpy).toHaveBeenCalledWith(
      '[baseline] - detection-pass: DetectionError at [redacted URL]: page.goto failed at [redacted URL] and [redacted URL]',
    );
  } finally {
    warningSpy.mockRestore();
    fs.rmSync(resultsPath, { recursive: true, force: true });
  }
});
