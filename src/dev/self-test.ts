/**
 * ZotSeek Self-Test Harness
 *
 * Mounted only when `extensions.zotseek.devMode` is true. Exposes a
 * runner that executes named test suites and returns a deterministic
 * JSON result. Each suite corresponds to one task in the v8 refactor plan.
 *
 * Invoke from MCP via:
 *   await Zotero.ZotSeek._selfTest.runSelfTest('task-N-name')
 */

import { Logger } from '../utils/logger';

declare const Zotero: any;

const logger = new Logger('SelfTest');

export interface Scenario {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  details?: string;
}

export interface TestResult {
  taskName: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  scenarios: Scenario[];
  newErrorsInLog: string[];
}

type SuiteFn = () => Promise<Scenario[]>;

class SelfTestRunner {
  private suites = new Map<string, SuiteFn>();
  private errorBaseline = 0;

  register(taskName: string, suite: SuiteFn): void {
    if (this.suites.has(taskName)) {
      logger.warn(`Self-test suite '${taskName}' already registered, overwriting`);
    }
    this.suites.set(taskName, suite);
  }

  list(): string[] {
    return Array.from(this.suites.keys());
  }

  /**
   * Capture the current error-log count so we can detect new errors emitted
   * while the suite runs. Call right before runSelfTest if you want a clean
   * baseline; runSelfTest does it automatically.
   */
  private captureLogBaseline(): number {
    try {
      const output = Zotero.Debug.getConsoleViewerOutput?.() || [];
      this.errorBaseline = output.filter((l: string) =>
        l.includes('[ZotSeek]') && /error/i.test(l)
      ).length;
    } catch {
      this.errorBaseline = 0;
    }
    return this.errorBaseline;
  }

  private collectNewErrors(): string[] {
    try {
      const output = Zotero.Debug.getConsoleViewerOutput?.() || [];
      const errors = output.filter((l: string) =>
        l.includes('[ZotSeek]') && /error/i.test(l)
      );
      return errors.slice(this.errorBaseline);
    } catch {
      return [];
    }
  }

  async runSelfTest(taskName: string): Promise<TestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    this.captureLogBaseline();

    const suite = this.suites.get(taskName);
    if (!suite) {
      return {
        taskName,
        startedAt,
        durationMs: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        scenarios: [],
        newErrorsInLog: [`No suite registered for '${taskName}'. Available: ${this.list().join(', ')}`],
      };
    }

    let scenarios: Scenario[] = [];
    try {
      scenarios = await suite();
    } catch (e: any) {
      scenarios.push({
        name: '__suite_threw__',
        status: 'fail',
        durationMs: Date.now() - t0,
        details: e?.message || String(e),
      });
    }

    const result: TestResult = {
      taskName,
      startedAt,
      durationMs: Date.now() - t0,
      passed: scenarios.filter(s => s.status === 'pass').length,
      failed: scenarios.filter(s => s.status === 'fail').length,
      skipped: scenarios.filter(s => s.status === 'skip').length,
      scenarios,
      newErrorsInLog: this.collectNewErrors(),
    };

    logger.info(`runSelfTest(${taskName}): ${result.passed}p / ${result.failed}f / ${result.skipped}s in ${result.durationMs}ms`);
    return result;
  }
}

export const selfTest = new SelfTestRunner();

/**
 * Helper: run a single assertion as a Scenario. Wraps timing and exception
 * capture so suite authors don't repeat boilerplate.
 */
export async function scenario(name: string, fn: () => Promise<void>): Promise<Scenario> {
  const t0 = Date.now();
  try {
    await fn();
    return { name, status: 'pass', durationMs: Date.now() - t0 };
  } catch (e: any) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - t0,
      details: e?.message || String(e),
    };
  }
}

/**
 * Assert helper. Throws on failure with a useful message; scenario() catches.
 */
export function assertEq<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message || 'assertEq failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertTrue(condition: any, message?: string): void {
  if (!condition) {
    throw new Error(message || 'assertTrue failed');
  }
}

export function assertContains(haystack: string | any[], needle: any, message?: string): void {
  const found = Array.isArray(haystack) ? haystack.includes(needle) : haystack.includes(String(needle));
  if (!found) {
    throw new Error(`${message || 'assertContains failed'}: ${JSON.stringify(needle)} not in ${JSON.stringify(haystack)}`);
  }
}

// Bootstrap suite: verifies the harness contract itself
selfTest.register('harness-bootstrap', async () => {
  return [
    await scenario('harness can register and call a suite', async () => {
      assertTrue(true, 'sanity');
    }),
    await scenario('assertEq detects mismatches', async () => {
      try {
        assertEq(1, 2, 'should fail');
        throw new Error('assertEq did NOT throw');
      } catch (e: any) {
        if (!e.message.includes('expected 2, got 1')) throw e;
      }
    }),
    await scenario('Zotero.DB is available', async () => {
      assertTrue(typeof Zotero.DB === 'object', 'Zotero.DB missing');
      assertTrue(typeof Zotero.DB.valueQueryAsync === 'function', 'valueQueryAsync missing');
    }),
  ];
});
