import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import {
  filesystemPathFromUri,
  isPathInsideAllowedRoots,
  listDefaultAllowedDirCandidates,
  normalizeMcpFilesystemPath,
  resolveAllowedRoots,
} from '../src/mcp/path-policy';

test('filesystemPathFromUri keeps native absolute paths', () => {
  if (process.platform === 'win32') {
    assert.equal(filesystemPathFromUri('C:\\Users\\example\\Pictures'), 'C:\\Users\\example\\Pictures');
    assert.equal(filesystemPathFromUri('C:/Users/example/Pictures'), 'C:/Users/example/Pictures');
    assert.equal(filesystemPathFromUri('z:\\Projects\\Image-Puma'), 'z:\\Projects\\Image-Puma');
  } else {
    assert.equal(filesystemPathFromUri('/tmp/images'), '/tmp/images');
  }
});

test('filesystemPathFromUri converts file URLs, including Windows drive letters', () => {
  assert.equal(
    filesystemPathFromUri('file:///C:/Users/example/Pictures', 'win32'),
    'C:\\Users\\example\\Pictures',
  );
  assert.equal(
    filesystemPathFromUri('file:///C%3A/Users/example/Pictures', 'win32'),
    'C:\\Users\\example\\Pictures',
  );
  assert.equal(
    filesystemPathFromUri('file://C:/Users/example/Pictures', 'win32'),
    'C:\\Users\\example\\Pictures',
  );
  assert.equal(
    filesystemPathFromUri('file:///tmp/images', 'linux'),
    '/tmp/images',
  );
});

test('filesystemPathFromUri rejects empty values and non-file URIs', () => {
  assert.equal(filesystemPathFromUri(''), null);
  assert.equal(filesystemPathFromUri('   '), null);
  assert.equal(filesystemPathFromUri('https://example.com/photo.jpg'), null);
  assert.equal(filesystemPathFromUri('relative/photo.jpg'), null);
});

test('isPathInsideAllowedRoots treats Windows drive letters as case-insensitive', () => {
  if (process.platform !== 'win32') return;

  const roots = [{ inputPath: 'C:\\Users\\example\\Pictures', realPath: 'C:\\Users\\example\\Pictures' }];
  assert.equal(isPathInsideAllowedRoots('c:\\Users\\example\\Pictures\\photo.jpg', roots), true);
  assert.equal(isPathInsideAllowedRoots(path.join('C:\\Users\\example\\Pictures', 'photo.jpg'), roots), true);
  assert.equal(isPathInsideAllowedRoots('D:\\other\\photo.jpg', roots), false);
});

test('listDefaultAllowedDirCandidates includes cwd and user image folders', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\example' : '/home/example';
  const cwd = process.platform === 'win32' ? 'Z:\\Projects\\Image-Puma' : '/work/Image-Puma';
  const dirs = listDefaultAllowedDirCandidates(home, cwd);
  assert.ok(dirs.includes(path.resolve(cwd)));
  assert.ok(dirs.includes(path.resolve(path.join(home, 'Downloads'))));
  assert.ok(dirs.includes(path.resolve(path.join(home, 'Pictures'))));
  assert.equal(
    listDefaultAllowedDirCandidates(home, path.parse(cwd).root)
      .some((dir) => dir === path.resolve(path.parse(cwd).root)),
    false,
  );
});

test('resolveAllowedRoots skipMissing ignores absent folders', async () => {
  const missing = path.join(os.tmpdir(), `image-puma-missing-root-${process.pid}`);
  const roots = await resolveAllowedRoots([missing], { skipMissing: true });
  assert.deepEqual(roots, []);
});

test('normalizeMcpFilesystemPath unwraps quotes and recovers mangled Windows escapes', () => {
  if (process.platform === 'win32') {
    assert.equal(
      normalizeMcpFilesystemPath('"C:\\Users\\example\\Pictures"'),
      'C:\\Users\\example\\Pictures',
    );
    assert.equal(
      normalizeMcpFilesystemPath('C:\\Users\example\\Pictures'),
      'C:\\Users\\example\\Pictures',
    );
  } else {
    assert.equal(normalizeMcpFilesystemPath('"/tmp/images"'), '/tmp/images');
  }
});
