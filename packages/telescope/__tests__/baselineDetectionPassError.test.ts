import { beforeEach, expect, test, vi } from 'vitest';

import type { BrowserConfigOptions } from '../src/types.js';

const mocks = vi.hoisted(() => {
  const page = { goto: vi.fn() };
  const context = {
    addCookies: vi.fn(),
    close: vi.fn(),
    newPage: vi.fn().mockResolvedValue(page),
    setExtraHTTPHeaders: vi.fn(),
  };
  const browser = {
    close: vi.fn(),
    newContext: vi.fn().mockResolvedValue(context),
  };

  return {
    browser,
    context,
    harvestInlineStyles: vi.fn(),
    launch: vi.fn().mockResolvedValue(browser),
    page,
  };
});

vi.mock('playwright', () => ({
  default: {
    chromium: { launch: mocks.launch },
    firefox: { launch: mocks.launch },
    webkit: { launch: mocks.launch },
  },
}));

vi.mock('../src/baselineCssExtract.js', () => ({
  harvestInlineStyles: mocks.harvestInlineStyles,
}));

import { runBaselineDetectionPass } from '../src/baselineDetectionPass.js';

const browserConfig: BrowserConfigOptions = {
  engine: 'chromium',
  headless: true,
  recordHar: { path: 'unused.har' },
  recordVideo: { dir: 'unused', size: { height: 720, width: 1280 } },
  viewport: { height: 720, width: 1280 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.launch.mockResolvedValue(mocks.browser);
  mocks.browser.newContext.mockResolvedValue(mocks.context);
  mocks.context.newPage.mockResolvedValue(mocks.page);
});

test('collects partial results after a navigation timeout and closes resources', async () => {
  const timeoutError = new Error('signed-url-secret');
  timeoutError.name = 'TimeoutError';
  mocks.page.goto.mockRejectedValue(timeoutError);
  mocks.harvestInlineStyles.mockResolvedValue([
    { css: '.partial {}', file: 'https://example.com (inline style #1)' },
  ]);
  const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  try {
    await expect(
      runBaselineDetectionPass({
        auth: { password: 'password', username: 'username' },
        browserConfig,
        preparePage: vi.fn().mockResolvedValue(undefined),
        timeout: 250,
        url: 'https://example.com/?token=secret',
      }),
    ).resolves.toEqual({
      inlineCSSSources: [
        { css: '.partial {}', file: 'https://example.com (inline style #1)' },
      ],
    });

    expect(mocks.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        httpCredentials: { password: 'password', username: 'username' },
      }),
    );
    expect(warningSpy).toHaveBeenCalledWith(
      '[baseline] - detection-navigation-timeout: exceeded 250ms',
    );
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(mocks.browser.close).toHaveBeenCalledOnce();
  } finally {
    warningSpy.mockRestore();
  }
});

test('closes resources when page preparation fails', async () => {
  const error = new Error('page preparation failed');

  await expect(
    runBaselineDetectionPass({
      browserConfig,
      preparePage: vi.fn().mockRejectedValue(error),
      timeout: 250,
      url: 'https://example.com',
    }),
  ).rejects.toBe(error);

  expect(mocks.page.goto).not.toHaveBeenCalled();
  expect(mocks.context.close).toHaveBeenCalledOnce();
  expect(mocks.browser.close).toHaveBeenCalledOnce();
});
