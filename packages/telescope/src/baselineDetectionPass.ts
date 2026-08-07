import playwright from 'playwright';

import { harvestInlineStyles } from './baselineCssExtract.js';
import { formatBaselineError } from './baselineError.js';
import type {
  BaselineDetectionPassOptions,
  BaselineDetectionPassResult,
} from './types.js';

/**
 * Collects live-DOM Baseline sources in a throwaway browser after the
 * performance run has completed.
 *
 * @param options - Browser, request-context, and navigation configuration.
 * @returns Inline CSS sources in document order.
 */
export async function runBaselineDetectionPass(
  options: BaselineDetectionPassOptions,
): Promise<BaselineDetectionPassResult> {
  const { browserConfig } = options;
  const browserType = playwright[browserConfig.engine];
  const browser = await browserType.launch({
    args: browserConfig.args,
    channel: browserConfig.channel,
    env: browserConfig.env,
    firefoxUserPrefs: browserConfig.firefoxUserPrefs,
    headless: browserConfig.headless,
    ignoreDefaultArgs: browserConfig.ignoreDefaultArgs,
  });

  try {
    const context = await browser.newContext({
      deviceScaleFactor: browserConfig.deviceScaleFactor,
      hasTouch: browserConfig.hasTouch,
      httpCredentials: options.auth || undefined,
      isMobile: browserConfig.isMobile,
      javaScriptEnabled: browserConfig.javaScriptEnabled,
      userAgent: browserConfig.userAgent,
      viewport: browserConfig.viewport,
    });

    try {
      if (options.headers) {
        await context.setExtraHTTPHeaders(options.headers);
      }

      if (options.cookies) {
        const cookies = (
          Array.isArray(options.cookies) ? options.cookies : [options.cookies]
        ).map(cookie => {
          const preparedCookie = { ...cookie };
          if (
            !preparedCookie.url &&
            (!preparedCookie.domain || !preparedCookie.path)
          ) {
            preparedCookie.url = options.url;
          }
          return preparedCookie;
        });
        await context.addCookies(cookies);
      }

      const page = await context.newPage();
      await options.preparePage(page);

      try {
        await page.goto(options.url, {
          timeout: options.timeout,
          waitUntil: 'networkidle',
        });
      } catch (error) {
        if ((error as Error).name !== 'TimeoutError') {
          throw error;
        }
        console.warn(
          `[baseline] - detection-navigation-timeout: exceeded ${options.timeout}ms`,
        );
      }

      const inlineCSSSources = await runCollector('inline-css', [], () =>
        harvestInlineStyles(page),
      );
      return { inlineCSSSources };
    } finally {
      await closeSafely('context', () => context.close());
    }
  } finally {
    await closeSafely('browser', () => browser.close());
  }
}

async function runCollector<T>(
  name: string,
  fallback: T,
  collect: () => Promise<T>,
): Promise<T> {
  try {
    return await collect();
  } catch (error) {
    console.warn(
      `[baseline] - ${name}-collector: ${formatBaselineError(error)}`,
    );
    return fallback;
  }
}

async function closeSafely(
  name: string,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    console.warn(
      `[baseline] - detection-${name}-cleanup: ${formatBaselineError(error)}`,
    );
  }
}
