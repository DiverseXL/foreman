import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ExternalTarget {
  name: string;
  repoUrl: string;
  parentSha: string;
  fixSha: string;
  testFiles: string[];
  testCommand: string;
  timeoutMs: number;
}

interface VitestAssertion {
  fullName: string;
  status: string;
  failureMessages?: string[];
}

interface VitestResult {
  testResults: {
    assertionResults: VitestAssertion[];
  }[];
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const targetsPath = path.join(repositoryRoot, 'external', 'targets.json');

function targets(): ExternalTarget[] {
  const value = JSON.parse(fs.readFileSync(targetsPath, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('external/targets.json must contain a list.');
  return value as ExternalTarget[];
}

function runGit(args: string[], cwd = repositoryRoot): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runInstaller(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
}

function installDependencies(targetDir: string): void {
  const packageFile = path.join(targetDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as {
    packageManager?: string;
  };
  const lockNames = fs.readdirSync(targetDir);
  if (lockNames.includes('pnpm-lock.yaml')) {
    const version = packageJson.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)/)?.[1];
    if (!version) throw new Error(`${packageFile} has a pnpm lockfile but no pinned pnpm packageManager.`);
    runInstaller('npx', ['--yes', `pnpm@${version}`, 'install', '--ignore-scripts'], targetDir);
    return;
  }
  if (lockNames.includes('yarn.lock')) {
    runInstaller('corepack', ['yarn', 'install', '--ignore-scripts'], targetDir);
    return;
  }
  runInstaller('npm', ['install', '--ignore-scripts'], targetDir);
}

function directVitestArgs(target: ExternalTarget, targetDir: string, reportPath: string): string[] {
  const typecheck = target.testCommand.includes('--typecheck');
  return [
    path.join(targetDir, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    ...(typecheck ? ['--typecheck'] : []),
    '--root',
    targetDir,
    '--testTimeout',
    String(target.timeoutMs),
    '--reporter=json',
    '--outputFile',
    reportPath,
  ];
}

function printDryRun(target: ExternalTarget, baseDir: string): void {
  const exists = fs.existsSync(path.join(baseDir, '.git'));
  console.log(`Target: ${target.name}`);
  console.log(`Pinned parent: ${target.parentSha}`);
  console.log(`Pinned fix tests: ${target.fixSha}`);
  console.log(`Base clone: ${baseDir} (${exists ? 'exists; clone will be reused' : 'missing; full-history clone would be created'})`);
  console.log(`Dependencies: install with lifecycle scripts disabled if node_modules is absent`);
  console.log(`Test command: ${target.testCommand}`);
  console.log('Dry run: no clone, checkout, file copy, install, or test execution performed.');
}

export function setupExternal(targetName: string, options: { dryRun?: boolean } = {}): void {
  const target = targets().find((item) => item.name === targetName);
  if (!target) throw new Error(`Unknown target "${targetName}". Valid targets: ${targets().map((item) => item.name).join(', ')}.`);
  const externalRoot = path.join(repositoryRoot, '.foreman-work', 'external', target.name);
  const baseDir = path.join(externalRoot, 'base');
  if (options.dryRun) {
    printDryRun(target, baseDir);
    return;
  }

  fs.mkdirSync(externalRoot, { recursive: true });
  if (!fs.existsSync(path.join(baseDir, '.git'))) {
    runGit(['clone', '--no-checkout', target.repoUrl, baseDir]);
  } else {
    console.log(`Reusing existing clone: ${baseDir}`);
  }
  runGit(['checkout', '--detach', target.parentSha], baseDir);
  const current = runGit(['rev-parse', 'HEAD'], baseDir);
  if (current !== target.parentSha) throw new Error(`Checkout mismatch: expected ${target.parentSha}, got ${current}.`);

  if (!fs.existsSync(path.join(baseDir, 'node_modules'))) {
    installDependencies(baseDir);
  } else {
    console.log('Dependencies already installed; reusing node_modules.');
  }

  for (const file of target.testFiles) {
    if (!file.startsWith('test/') || file.includes('..')) {
      throw new Error(`Refusing unexpected test path in target registry: ${file}`);
    }
    const contents = execFileSync('git', ['show', `${target.fixSha}:${file}`], {
      cwd: baseDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const destination = path.resolve(baseDir, file);
    if (!destination.startsWith(`${path.resolve(baseDir)}${path.sep}`)) {
      throw new Error(`Test path escapes target clone: ${file}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents, 'utf8');
  }

  const reportPath = path.join(externalRoot, `${target.name}-vitest-results.json`);
  const commandArgs = directVitestArgs(target, baseDir, reportPath);
  console.log(`Test command: node ${commandArgs.map((arg) => JSON.stringify(arg)).join(' ')}`);
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: baseDir,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Vitest did not write its JSON report (exit ${result.status}).\n${result.stderr ?? ''}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as VitestResult;
  const failures = report.testResults.flatMap((file) =>
    file.assertionResults.filter((item) => item.status === 'failed')
  );
  console.log(`Parent source with fix tests: ${report.testResults.reduce((count, file) => count + file.assertionResults.length, 0) - failures.length} passed, ${failures.length} failed.`);
  for (const failure of failures) {
    const assertion = failure.failureMessages?.find((message) => message.startsWith('AssertionError:'))?.split(/\r?\n/)[0];
    console.log(`FAIL ${failure.fullName}${assertion ? ` — ${assertion}` : ''}`);
  }
  if (result.status !== 1 || failures.length === 0) {
    throw new Error(`Expected deterministic fix-test failures at the parent; Vitest exited ${result.status}.`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const names = args.filter((arg) => arg !== '--dry-run');
  if (names.length !== 1) throw new Error('Usage: npm run setup-external -- <target-name> [--dry-run]');
  setupExternal(names[0], { dryRun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`External target setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
