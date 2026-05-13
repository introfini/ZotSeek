/**
 * ZotSeek Self-Test Harness
 *
 * Mounted only when `extensions.zotseek.devMode` is true. Exposes a
 * runner that executes named test suites and returns a deterministic
 * JSON result. Each suite corresponds to one task in the v8 refactor plan.
 *
 * Invoke from MCP via:
 *   await Zotero.ZotSeek._selfTest.runSelfTest('task-N-name')
 *
 * Future task suites should live in their own files under `src/dev/suites/`
 * and import `selfTest`, `scenario`, and the assert helpers from `../self-test`.
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

  /**
   * Register a suite. Throws if a suite with the same name already exists.
   * Dev-only infrastructure: fail fast so name clashes surface immediately
   * instead of silently overwriting earlier registrations.
   */
  register(taskName: string, suite: SuiteFn): void {
    if (this.suites.has(taskName)) {
      throw new Error(`Self-test suite '${taskName}' already registered`);
    }
    this.suites.set(taskName, suite);
  }

  list(): string[] {
    return Array.from(this.suites.keys());
  }

  /**
   * Verify that the registry contains exactly the expected set of suites.
   * Returns the missing and extra suite names so callers (MCP runner, CI,
   * humans) can fail loudly if a task forgot to import its suite module.
   *
   * Doesn't throw or mutate state; pure diagnostic helper.
   */
  verifyRegistry(expected: string[]): { missing: string[]; extra: string[] } {
    const present = new Set(this.suites.keys());
    const wanted = new Set(expected);
    const missing = expected.filter(n => !present.has(n));
    const extra = Array.from(present).filter(n => !wanted.has(n));
    return { missing, extra };
  }

  /**
   * Capture the current error-log count so we can detect new errors emitted
   * while the suite runs. Returns the baseline; caller passes it back to
   * `collectNewErrors`. Local to each runSelfTest call so concurrent
   * invocations don't clobber each other.
   */
  private captureLogBaseline(): number {
    try {
      const output = Zotero.Debug.getConsoleViewerOutput?.() || [];
      return output.filter((l: string) =>
        l.includes('[ZotSeek') && /error/i.test(l)
      ).length;
    } catch {
      return 0;
    }
  }

  private collectNewErrors(baseline: number): string[] {
    try {
      const output = Zotero.Debug.getConsoleViewerOutput?.() || [];
      const errors = output.filter((l: string) =>
        l.includes('[ZotSeek') && /error/i.test(l)
      );
      return errors.slice(baseline);
    } catch {
      return [];
    }
  }

  async runSelfTest(taskName: string): Promise<TestResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const baseline = this.captureLogBaseline();

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
      newErrorsInLog: this.collectNewErrors(baseline),
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

export function assertTrue(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || 'assertTrue failed');
  }
}

export function assertContains<T>(haystack: string | readonly T[], needle: T, message?: string): void {
  const found = Array.isArray(haystack)
    ? haystack.includes(needle)
    : (haystack as string).includes(String(needle));
  if (!found) {
    throw new Error(`${message || 'assertContains failed'}: ${JSON.stringify(needle)} not in ${JSON.stringify(haystack)}`);
  }
}

// Bootstrap suite: verifies the harness contract itself.
// Future task suites should live under src/dev/suites/ in their own files.
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
