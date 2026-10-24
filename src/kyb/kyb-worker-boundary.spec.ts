import { readdirSync, readFileSync } from 'fs';
import { basename, join, relative, sep } from 'path';

// Import guard (docs/adrs/auth.md): the worker-only repository is unscoped, so it must stay
// reachable only from the worker.
// - Outside src/kyb/, no file may mention its module path or its class name.
// - Inside src/kyb/, only the module, the processor, the repository and their specs may name the
//   class, and no non-spec file may declare a controller or re-export with `export *` (a barrel
//   would let code outside src/kyb/ import it without naming the module path).
const SRC_DIR = join(__dirname, '..');
const KYB_DIR = __dirname;
const GUARDED_MODULE = 'kyb-worker-applications.repository';
const GUARDED_CLASS = 'KybWorkerApplicationsRepository';
const ALLOWED_IN_KYB = new Set([
  'kyb.module.ts',
  'kyb.module.spec.ts',
  'kyb-check.processor.ts',
  'kyb-check.processor.spec.ts',
  'kyb-worker-applications.repository.ts',
  'kyb-worker-applications.repository.spec.ts',
  // This spec names the class to search for it.
  'kyb-worker-boundary.spec.ts',
]);

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function contains(path: string, text: string): boolean {
  return readFileSync(path, 'utf8').includes(text);
}

function isInsideKyb(path: string): boolean {
  return path.startsWith(KYB_DIR + sep);
}

function isSpec(path: string): boolean {
  return path.endsWith('.spec.ts');
}

describe('KYB worker repository boundary', () => {
  const files = listTsFiles(SRC_DIR);
  const kybFiles = files.filter(isInsideKyb);
  const outsideFiles = files.filter((path) => !isInsideKyb(path));

  it('finds the repository mentioned inside src/kyb/ (the walker works)', () => {
    expect(kybFiles.filter((path) => contains(path, GUARDED_MODULE)).length).toBeGreaterThan(0);
    expect(kybFiles.filter((path) => contains(path, GUARDED_CLASS)).length).toBeGreaterThan(0);
    expect(outsideFiles.length).toBeGreaterThan(0);
  });

  it('no .ts file outside src/kyb/ mentions kyb-worker-applications.repository', () => {
    const offending = outsideFiles
      .filter((path) => contains(path, GUARDED_MODULE))
      .map((path) => relative(SRC_DIR, path));

    expect(offending).toEqual([]);
  });

  it('no .ts file outside src/kyb/ mentions KybWorkerApplicationsRepository', () => {
    const offending = outsideFiles
      .filter((path) => contains(path, GUARDED_CLASS))
      .map((path) => relative(SRC_DIR, path));

    expect(offending).toEqual([]);
  });

  it('inside src/kyb/, only the module, processor, repository and their specs name the class', () => {
    const offending = kybFiles
      .filter((path) => !ALLOWED_IN_KYB.has(basename(path)) && contains(path, GUARDED_CLASS))
      .map((path) => relative(SRC_DIR, path));

    expect(offending).toEqual([]);
  });

  it('no non-spec file in src/kyb/ declares a controller or uses export *', () => {
    const offending = kybFiles
      .filter((path) => !isSpec(path))
      .filter((path) => contains(path, '@Controller') || contains(path, 'export *'))
      .map((path) => relative(SRC_DIR, path));

    expect(offending).toEqual([]);
  });
});
