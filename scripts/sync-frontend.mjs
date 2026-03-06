import { execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positional = args.filter((arg) => !arg.startsWith('--'));

const dryRun = flags.has('--dry-run');
const skipBuild = flags.has('--skip-build');
const repoRoot = process.cwd();
const frontendRoot = resolve(
  process.env.FRONTEND_REPO_PATH || positional[0] || '../Sanyue-ImgHub',
);
const distRoot = resolve(frontendRoot, 'dist');
const knownFrontendArtifacts = [
  'css',
  'fonts',
  'img',
  'js',
  'index.html',
  'index.html.gz',
  'logo-dark.png',
  'logo.png',
];

function log(message) {
  console.log(`[sync:frontend] ${message}`);
}

function fail(message) {
  console.error(`[sync:frontend] ${message}`);
  process.exit(1);
}

function relativeToRepo(targetPath) {
  return relative(repoRoot, targetPath) || '.';
}

function removeTarget(targetPath) {
  if (!existsSync(targetPath)) return;
  const type = lstatSync(targetPath).isDirectory() ? 'directory' : 'file';
  log(`${dryRun ? 'Would remove' : 'Removing'} ${type} ${relativeToRepo(targetPath)}`);
  if (!dryRun) {
    rmSync(targetPath, { recursive: true, force: true });
  }
}

function copyTarget(sourcePath, targetPath) {
  log(
    `${dryRun ? 'Would copy' : 'Copying'} ${relative(frontendRoot, sourcePath)} -> ${relativeToRepo(targetPath)}`,
  );
  if (!dryRun) {
    cpSync(sourcePath, targetPath, { recursive: true, force: true });
  }
}

if (!existsSync(resolve(frontendRoot, 'package.json'))) {
  fail(`Frontend repo not found at ${frontendRoot}`);
}

if (!skipBuild) {
  log(`Building frontend from ${frontendRoot}`);
  execSync('npm run build', {
    cwd: frontendRoot,
    stdio: 'inherit',
  });
}

if (!existsSync(distRoot)) {
  fail(`Frontend dist directory not found at ${distRoot}`);
}

const distEntries = readdirSync(distRoot);
if (distEntries.length === 0) {
  fail(`Frontend dist directory is empty: ${distRoot}`);
}

const cleanupTargets = [...new Set([...knownFrontendArtifacts, ...distEntries])];
log(`Preparing to sync ${distEntries.length} dist entries from ${relativeToRepo(distRoot)}`);

for (const entry of cleanupTargets) {
  removeTarget(resolve(repoRoot, entry));
}

for (const entry of distEntries) {
  copyTarget(resolve(distRoot, entry), resolve(repoRoot, entry));
}

log(dryRun ? 'Dry run complete.' : 'Sync complete. Review changes with git status.');

