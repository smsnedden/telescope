import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { extractCSSFromHar } from './baselineCssExtract.js';
import { formatBaselineError } from './baselineError.js';
import { getPackageVersion } from './packageVersion.js';
import type {
  BaselineDetectionPassResult,
  BaselinePipelineOptions,
  HarData,
  JSONValue,
} from './types.js';

export const BASELINE_SCHEMA_VERSION = 1;

/**
 * Writes a JSON artifact beneath the results baseline directory.
 * @param resultsPath - Directory containing the performance test results.
 * @param artifactPath - Path relative to the baseline directory.
 * @param artifact - JSON-compatible artifact content.
 * @throws If the artifact path escapes the baseline directory or writing fails.
 */
export function writeBaselineArtifact(
  resultsPath: string,
  artifactPath: string,
  artifact: JSONValue,
): void {
  const baselinePath = path.resolve(resultsPath, 'baseline');
  const outputPath = path.resolve(baselinePath, artifactPath);
  if (
    outputPath !== baselinePath &&
    !outputPath.startsWith(baselinePath + path.sep)
  ) {
    throw new Error(`Invalid baseline artifact path: ${artifactPath}`);
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact), 'utf8');
}

/**
 * Runs the post-performance Baseline analysis pipeline.
 *
 * Detection and analysis stages are added incrementally. The pipeline writes a
 * run manifest and the CSS sources collected from the HAR and live DOM.
 *
 * @param options - Completed test URL and results location.
 */
export async function runBaselinePipeline(
  options: BaselinePipelineOptions,
): Promise<void> {
  const meta = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    telescopeVersion: getPackageVersion(),
    timestamp: new Date().toISOString(),
    url: options.url,
  };

  writeBaselineArtifact(options.resultsPath, 'meta.json', meta);

  const harData = JSON.parse(
    readFileSync(path.join(options.resultsPath, 'pageload.har'), 'utf8'),
  ) as HarData;
  let detectionResult: BaselineDetectionPassResult = { inlineCSSSources: [] };
  try {
    detectionResult = await options.runDetectionPass();
  } catch (error) {
    console.warn(`[baseline] - detection-pass: ${formatBaselineError(error)}`);
  }
  const cssSources = [
    ...extractCSSFromHar(harData),
    ...detectionResult.inlineCSSSources,
  ];

  writeBaselineArtifact(
    options.resultsPath,
    'detection/css-sources.json',
    cssSources.map(({ css, file }) => ({ css, file })),
  );
}
