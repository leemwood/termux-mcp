import { isUtf8 } from 'node:buffer';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PolicyError, assertDeleteAllowed, assertPathAllowed } from '../security.js';

function formatMode(mode) {
  return `0o${(mode & 0o7777).toString(8).padStart(4, '0')}`;
}

function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function typeOf(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isCharacterDevice()) return 'char-device';
  if (stat.isBlockDevice()) return 'block-device';
  return 'other';
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

async function atomicWrite(file, data, mode) {
  const dir = path.dirname(file);
  const name = `.${path.basename(file)}.termux-mcp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const tmp = path.join(dir, name);

  try {
    await fsp.writeFile(tmp, data, { mode: mode ?? 0o644, flag: 'wx' });
    if (mode !== undefined) await fsp.chmod(tmp, mode).catch(() => {});
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length;
}

function addLineNumbers(lines, startLine) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width)} | ${line}`).join('\n');
}

export function registerFileTools(register, { config }) {
  register({
    name: 'read_file',
    title: 'Read a text file',
    description:
      'Read a file from an allowed directory (home, shared storage or Termux tmp) as text. Supports line offsets and line numbering. Binary files must be read with encoding="base64". Large reads are limited by security.maxReadBytes.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      path: register.z.string().min(1).describe('Absolute path or path relative to $HOME.'),
      offset: register.z.number().int().min(1).optional().describe('First line to return (1-based). Default 1.'),
      limit: register.z
        .number()
        .int()
        .min(1)
        .max(20000)
        .optional()
        .describe('Maximum number of lines to return. Default 2000.'),
      with_line_numbers: register.z.boolean().optional().describe('Prefix every line with its line number.'),
      encoding: register.z
        .string()
        .optional()
        .describe('Buffer encoding, e.g. utf8, latin1, base64. Default utf8.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.path, { write: false, label: 'path' });
      const stat = await fsp.stat(allowed.real);
      if (!stat.isFile()) throw new PolicyError(`Not a regular file: ${allowed.resolved}`);

      const limitBytes = config.security.maxReadBytes;
      if (stat.size > limitBytes) {
        throw new PolicyError(
          `File is ${stat.size} bytes, larger than security.maxReadBytes (${limitBytes}). Increase the limit or use search_files/run_command.`,
        );
      }

      const encoding = (args.encoding || 'utf8').toLowerCase();
      if (!Buffer.isEncoding(encoding)) {
        throw new PolicyError(`Unsupported encoding: ${args.encoding}`);
      }

      const buffer = await fsp.readFile(allowed.real);
      if (!args.encoding && looksBinary(buffer)) {
        throw new PolicyError(
          'This looks like a binary file. Pass encoding="base64" to read it, or use run_command.',
        );
      }
      if ((encoding === 'utf8' || encoding === 'utf-8') && !isUtf8(buffer)) {
        throw new PolicyError(
          'File is not valid UTF-8. Pass encoding="base64" or another encoding such as "latin1".',
        );
      }

      let text = buffer.toString(encoding);
      if (encoding === 'base64') return text;

      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(Math.max(1, Number(args.limit) || 2000), 20000);
      const lines = text.split('\n');
      const totalLines = lines.length;
      const start = Math.min(offset - 1, totalLines);
      const end = Math.min(totalLines, start + limit);
      const selected = lines.slice(start, end);
      const wasSliced = start > 0 || end < totalLines;

      text = args.with_line_numbers ? addLineNumbers(selected, start + 1) : selected.join('\n');

      if (wasSliced) {
        text += `\n…[termux-mcp: showing lines ${start + 1}-${end} of ${totalLines}; use offset/limit]…`;
      }
      return text;
    },
  });

  register({
    name: 'write_file',
    title: 'Write or append to a file',
    description:
      'Create, overwrite or append to a text file inside an allowed directory. Writes are atomic for overwrite mode. Parent directories can be created automatically. Content is returned as a small JSON summary.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      path: register.z.string().min(1).describe('Absolute path or path relative to $HOME.'),
      content: register.z.string().describe('File content.'),
      encoding: register.z.string().optional().describe('Encoding of content. Default utf8. Use base64 for binary.'),
      append: register.z.boolean().optional().describe('Append instead of overwriting. Default false.'),
      create_parents: register.z.boolean().optional().describe('Create missing parent directories. Default true.'),
    },
    handler: async (args) => {
      const encoding = (args.encoding || 'utf8').toLowerCase();
      if (!Buffer.isEncoding(encoding)) throw new PolicyError(`Unsupported encoding: ${args.encoding}`);

      const data = Buffer.from(args.content, encoding);
      if (data.length > config.security.maxWriteBytes) {
        throw new PolicyError(
          `Content is ${data.length} bytes, larger than security.maxWriteBytes (${config.security.maxWriteBytes}).`,
        );
      }

      const allowed = await assertPathAllowed(config, args.path, { write: true, label: 'path' });
      const createParents = args.create_parents !== false;
      if (createParents) {
        await fsp.mkdir(path.dirname(allowed.real), { recursive: true, mode: 0o755 });
      }

      let existing = null;
      try {
        existing = await fsp.stat(allowed.real);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (args.append) {
        await fsp.appendFile(allowed.real, data, { mode: 0o644 });
        const stat = await fsp.stat(allowed.real);
        return JSON.stringify(
          {
            path: allowed.real,
            mode: 'append',
            bytes_written: data.length,
            size: stat.size,
            created: !existing,
          },
          null,
          2,
        );
      }

      const mode = existing ? existing.mode & 0o777 : 0o644;
      await atomicWrite(allowed.real, data, mode);
      const stat = await fsp.stat(allowed.real);
      return JSON.stringify(
        {
          path: allowed.real,
          mode: 'overwrite',
          bytes_written: data.length,
          size: stat.size,
          created: !existing,
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'edit_file',
    title: 'Replace text in a file',
    description:
      'Replace an exact string in a UTF-8 text file. By default old_string must occur exactly once; use replace_all to replace every occurrence. The file is written atomically.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      path: register.z.string().min(1).describe('Absolute path or path relative to $HOME.'),
      old_string: register.z.string().min(1).describe('Exact text to find.'),
      new_string: register.z.string().describe('Replacement text.'),
      replace_all: register.z.boolean().optional().describe('Replace all occurrences. Default false.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.path, { write: true, label: 'path' });
      const stat = await fsp.stat(allowed.real);
      if (!stat.isFile()) throw new PolicyError(`Not a regular file: ${allowed.resolved}`);
      if (stat.size > config.security.maxWriteBytes) {
        throw new PolicyError(`File is larger than security.maxWriteBytes (${config.security.maxWriteBytes}).`);
      }

      const buffer = await fsp.readFile(allowed.real);
      if (buffer.subarray(0, 8192).includes(0) || !isUtf8(buffer)) {
        throw new PolicyError('File does not look like UTF-8 text.');
      }
      const before = buffer.toString('utf8');

      const occurrences = before.split(args.old_string).length - 1;
      if (occurrences === 0) throw new PolicyError('old_string was not found in the file.');
      if (occurrences > 1 && !args.replace_all) {
        throw new PolicyError(
          `old_string occurs ${occurrences} times. Add more context or set replace_all=true.`,
        );
      }

      const after = args.replace_all
        ? before.split(args.old_string).join(args.new_string)
        : before.replace(args.old_string, () => args.new_string);

      const data = Buffer.from(after, 'utf8');
      if (data.length > config.security.maxWriteBytes) {
        throw new PolicyError(`Result is larger than security.maxWriteBytes (${config.security.maxWriteBytes}).`);
      }

      await atomicWrite(allowed.real, data, stat.mode & 0o777);
      return JSON.stringify(
        {
          path: allowed.real,
          replacements: args.replace_all ? occurrences : 1,
          old_bytes: stat.size,
          new_bytes: data.length,
          lines: await lineCount(after),
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'list_dir',
    title: 'List a directory',
    description:
      'List files and subdirectories with type, size, modification time and permissions. Symlinks are reported but not followed. Hidden entries are skipped unless show_hidden=true.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      path: register.z.string().optional().describe('Directory path. Default $HOME.'),
      show_hidden: register.z.boolean().optional().describe('Include names starting with a dot. Default false.'),
      max_entries: register.z.number().int().min(1).max(5000).optional().describe('Default 500.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.path || '~', { write: false, label: 'path' });
      const stat = await fsp.stat(allowed.real);
      if (!stat.isDirectory()) throw new PolicyError(`Not a directory: ${allowed.resolved}`);

      const maxEntries = Math.min(Math.max(1, Number(args.max_entries) || 500), 5000);
      const showHidden = Boolean(args.show_hidden);
      const dirents = await fsp.readdir(allowed.real, { withFileTypes: true });
      const filtered = dirents.filter((entry) => showHidden || !entry.name.startsWith('.'));
      filtered.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const entries = [];
      for (const entry of filtered.slice(0, maxEntries)) {
        const full = path.join(allowed.real, entry.name);
        try {
          const info = await fsp.lstat(full);
          const item = {
            name: entry.name,
            type: typeOf(info),
            size: info.size,
            mtime: info.mtime.toISOString(),
            mode: formatMode(info.mode),
          };
          if (info.isSymbolicLink()) {
            item.link_target = await fsp.readlink(full).catch(() => null);
          }
          entries.push(item);
        } catch (error) {
          entries.push({ name: entry.name, type: 'unknown', error: error.code || error.message });
        }
      }

      return JSON.stringify(
        {
          path: allowed.real,
          total: filtered.length,
          returned: entries.length,
          truncated: filtered.length > entries.length,
          entries,
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'stat_path',
    title: 'Inspect a path',
    description:
      'Return stat information for a file, directory or symlink, including size, permissions, timestamps and the resolved real path.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      path: register.z.string().min(1).describe('Absolute path or path relative to $HOME.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.path, { write: false, label: 'path' });
      const stat = await fsp.lstat(allowed.resolved);
      return JSON.stringify(
        {
          path: allowed.resolved,
          realpath: allowed.real,
          type: typeOf(stat),
          size: stat.size,
          mode: formatMode(stat.mode),
          uid: stat.uid,
          gid: stat.gid,
          mtime: stat.mtime.toISOString(),
          atime: stat.atime.toISOString(),
          ctime: stat.ctime.toISOString(),
          is_symlink: stat.isSymbolicLink(),
          link_target: stat.isSymbolicLink() ? await fsp.readlink(allowed.resolved).catch(() => null) : null,
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'mkdir',
    title: 'Create a directory',
    description: 'Create a directory. Parent directories are created by default.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    schema: {
      path: register.z.string().min(1).describe('Directory path.'),
      recursive: register.z.boolean().optional().describe('Create parents and tolerate an existing directory. Default true.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.path, { write: true, label: 'path' });
      const recursive = args.recursive !== false;
      let existed = false;
      try {
        const stat = await fsp.stat(allowed.real);
        if (!stat.isDirectory()) throw new PolicyError(`Path exists and is not a directory: ${allowed.real}`);
        existed = true;
        if (!recursive) return JSON.stringify({ path: allowed.real, created: false, existed: true }, null, 2);
      } catch (error) {
        if (error instanceof PolicyError) throw error;
        if (error.code !== 'ENOENT') throw error;
      }

      await fsp.mkdir(allowed.real, { recursive, mode: 0o755 });
      return JSON.stringify({ path: allowed.real, created: !existed, existed }, null, 2);
    },
  });

  register({
    name: 'copy_path',
    title: 'Copy a file or directory',
    description:
      'Copy a file or directory to another path. Directories are copied recursively; existing destinations require overwrite=true.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    schema: {
      source: register.z.string().min(1).describe('Source path.'),
      destination: register.z.string().min(1).describe('Destination path.'),
      overwrite: register.z.boolean().optional().describe('Replace an existing destination. Default false.'),
    },
    handler: async (args) => {
      const source = await assertPathAllowed(config, args.source, { write: false, label: 'source' });
      const destination = await assertPathAllowed(config, args.destination, { write: true, label: 'destination' });
      const stat = await fsp.lstat(source.real);

      if (source.real === destination.real) {
        throw new PolicyError('Source and destination are the same path.');
      }
      if (stat.isDirectory() && isSameOrInside(source.real, destination.real)) {
        throw new PolicyError('Cannot copy a directory into itself.');
      }

      let destExists = false;
      try {
        await fsp.lstat(destination.real);
        destExists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (destExists && !args.overwrite) {
        throw new PolicyError(`Destination already exists: ${destination.real}. Pass overwrite=true to replace it.`);
      }
      if (destExists && args.overwrite) {
        await assertDeleteAllowed(config, destination.real, { label: 'destination' });
        await fsp.rm(destination.real, { recursive: true, force: true });
      }

      await fsp.mkdir(path.dirname(destination.real), { recursive: true, mode: 0o755 });
      await fsp.cp(source.real, destination.real, {
        recursive: stat.isDirectory(),
        force: false,
        errorOnExist: true,
        dereference: false,
        preserveTimestamps: true,
      });

      return JSON.stringify(
        {
          source: source.real,
          destination: destination.real,
          type: typeOf(stat),
          overwritten: destExists,
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'move_path',
    title: 'Move or rename a path',
    description:
      'Move or rename a file or directory. Existing destinations require overwrite=true. Cross-filesystem moves fall back to copy + delete.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      source: register.z.string().min(1).describe('Source path.'),
      destination: register.z.string().min(1).describe('Destination path.'),
      overwrite: register.z.boolean().optional().describe('Replace an existing destination. Default false.'),
    },
    handler: async (args) => {
      const source = await assertPathAllowed(config, args.source, { write: false, label: 'source' });
      const destination = await assertPathAllowed(config, args.destination, { write: true, label: 'destination' });
      await assertDeleteAllowed(config, source.real, { label: 'source' });

      if (source.real === destination.real) {
        throw new PolicyError('Source and destination are the same path.');
      }
      const stat = await fsp.lstat(source.real);
      if (stat.isDirectory() && isSameOrInside(source.real, destination.real)) {
        throw new PolicyError('Cannot move a directory into itself.');
      }
      let destExists = false;
      try {
        await fsp.lstat(destination.real);
        destExists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (destExists && !args.overwrite) {
        throw new PolicyError(`Destination already exists: ${destination.real}. Pass overwrite=true to replace it.`);
      }
      if (destExists && args.overwrite) {
        await assertDeleteAllowed(config, destination.real, { label: 'destination' });
        await fsp.rm(destination.real, { recursive: true, force: true });
      }

      await fsp.mkdir(path.dirname(destination.real), { recursive: true, mode: 0o755 });
      let method = 'rename';
      try {
        await fsp.rename(source.real, destination.real);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        method = 'copy+delete';
        await fsp.cp(source.real, destination.real, {
          recursive: stat.isDirectory(),
          force: false,
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
        await fsp.rm(source.real, { recursive: true, force: false });
      }

      return JSON.stringify(
        {
          source: source.real,
          destination: destination.real,
          type: typeOf(stat),
          method,
          overwritten: destExists,
        },
        null,
        2,
      );
    },
  });

  register({
    name: 'delete_path',
    title: 'Delete a path',
    description:
      'Delete a file, symlink or directory. Destructive: first call with dry_run=true to inspect the target, then call again with confirm="DELETE". The filesystem root / is always refused; all other paths are allowed subject to the Termux user\'s Android permissions.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    schema: {
      path: register.z.string().min(1).describe('Path to delete.'),
      recursive: register.z.boolean().optional().describe('Allow deleting a non-empty directory. Default false.'),
      dry_run: register.z.boolean().optional().describe('Only report what would be deleted. Default false.'),
      confirm: register.z.string().optional().describe('Must be exactly "DELETE" for a real deletion.'),
    },
    handler: async (args) => {
      const allowed = await assertDeleteAllowed(config, args.path, { label: 'path' });
      const stat = await fsp.lstat(allowed.real);
      const type = typeOf(stat);
      const recursive = Boolean(args.recursive);

      let entries = 1;
      let bytes = stat.isFile() ? stat.size : 0;
      let partial = false;

      async function measure(target, budget) {
        if (budget.entries <= 0) {
          budget.partial = true;
          return;
        }
        if (budget.entries-- <= 0) return;
        const info = await fsp.lstat(target);
        if (info.isSymbolicLink()) return;
        if (info.isDirectory()) {
          let names;
          try {
            names = await fsp.readdir(target);
          } catch {
            budget.partial = true;
            return;
          }
          for (const name of names) {
            if (budget.entries <= 0) {
              budget.partial = true;
              return;
            }
            entries += 1;
            await measure(path.join(target, name), budget);
          }
        } else {
          bytes += info.size;
        }
      }

      if (stat.isDirectory()) {
        const budget = { entries: 10000, partial: false };
        await measure(allowed.real, budget);
        partial = budget.partial;
      }

      if (stat.isDirectory() && !recursive) {
        throw new PolicyError(
          `Refusing to delete a directory without recursive=true: ${allowed.real}`,
        );
      }

      const summary = {
        path: allowed.real,
        type,
        recursive,
        entries,
        bytes,
        measured_partially: partial,
        dry_run: Boolean(args.dry_run),
        deleted: false,
      };

      if (args.dry_run) {
        summary.required_confirm = 'DELETE';
        return JSON.stringify(summary, null, 2);
      }

      if (args.confirm !== 'DELETE') {
        throw new PolicyError('Deletion requires confirm="DELETE". Call again with dry_run=true first if unsure.');
      }

      if (stat.isDirectory()) {
        await fsp.rm(allowed.real, { recursive: true, force: false });
      } else {
        await fsp.rm(allowed.real, { force: false });
      }

      summary.deleted = true;
      return JSON.stringify(summary, null, 2);
    },
  });

  register({
    name: 'search_files',
    title: 'Search files by name or content',
    description:
      'Recursively search below a root for files matching a glob and optionally a regular expression in their contents. Symlinks are skipped. Returns up to max_results matches.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    schema: {
      root: register.z.string().optional().describe('Directory to search. Default $HOME.'),
      glob: register.z.string().optional().describe('Glob for names or relative paths, e.g. "*.js" or "src/**/*.ts". Default "*".'),
      query: register.z.string().optional().describe('Regular expression to match in file contents.'),
      max_results: register.z.number().int().min(1).max(1000).optional().describe('Default 100.'),
      include_hidden: register.z.boolean().optional().describe('Include hidden files and directories. Default false.'),
      case_sensitive: register.z.boolean().optional().describe('Case-sensitive content matching. Default true.'),
      max_depth: register.z.number().int().min(1).max(64).optional().describe('Directory depth limit. Default 12.'),
      max_file_bytes: register.z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024)
        .optional()
        .describe('Skip content search in larger files. Default 1 MiB.'),
    },
    handler: async (args) => {
      const allowed = await assertPathAllowed(config, args.root || '~', { write: false, label: 'root' });
      let queryRegex = null;
      if (args.query) {
        try {
          queryRegex = new RegExp(args.query, args.case_sensitive === false ? 'i' : '');
        } catch (error) {
          throw new PolicyError(`Invalid query regex: ${error.message}`);
        }
      }

      const maxResults = Math.min(Number(args.max_results) || config.security.maxSearchResults, 1000);
      const maxDepth = Number(args.max_depth) || 12;
      const maxFileBytes = Number(args.max_file_bytes) || 1024 * 1024;
      const includeHidden = Boolean(args.include_hidden);
      const glob = args.glob || '*';
      const globRegex = globToRegExp(glob);
      const globMatchesPath = glob.includes('/');
      const deadline = Date.now() + config.security.searchTimeoutSec * 1000;
      const rootStat = await fsp.lstat(allowed.real);
      const matches = [];
      let scanned = 0;
      let stopped = false;

      const relative = (full) => path.relative(allowed.real, full).split(path.sep).join('/');

      async function visit(current, depth) {
        if (stopped) return;
        if (Date.now() > deadline) {
          stopped = true;
          return;
        }
        let entries;
        try {
          entries = await fsp.readdir(current, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (stopped) return;
          if (!includeHidden && entry.name.startsWith('.')) continue;

          const full = path.join(current, entry.name);
          let info;
          try {
            info = await fsp.lstat(full);
          } catch {
            continue;
          }
          if (info.isSymbolicLink()) continue;

          if (info.isDirectory()) {
            if (depth < maxDepth) await visit(full, depth + 1);
            continue;
          }
          if (!info.isFile()) continue;

          scanned += 1;
          if (scanned > 20000) {
            stopped = true;
            return;
          }

          const rel = relative(full);
          const target = globMatchesPath ? rel : entry.name;
          if (!globRegex.test(target)) continue;

          if (!queryRegex) {
            matches.push({ path: full });
          } else {
            if (info.size > maxFileBytes) continue;
            let buffer;
            try {
              buffer = await fsp.readFile(full);
            } catch {
              continue;
            }
            if (looksBinary(buffer)) continue;
            const text = buffer.toString('utf8');
            const lines = text.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              if (queryRegex.test(lines[index])) {
                matches.push({
                  path: full,
                  line: index + 1,
                  text: lines[index].trim().slice(0, 500),
                });
                if (matches.length >= maxResults) {
                  stopped = true;
                  return;
                }
              }
            }
          }

          if (matches.length >= maxResults) {
            stopped = true;
            return;
          }
        }
      }

      if (rootStat.isDirectory()) await visit(allowed.real, 0);
      else {
        const rel = path.basename(allowed.real);
        if (globRegex.test(globMatchesPath ? rel : path.basename(allowed.real))) {
          matches.push({ path: allowed.real });
        }
      }

      return JSON.stringify(
        {
          root: allowed.real,
          glob,
          query: args.query || null,
          scanned,
          matches,
          truncated: stopped,
          duration_ms: config.security.searchTimeoutSec * 1000 - Math.max(0, deadline - Date.now()),
        },
        null,
        2,
      );
    },
  });
}

function globToRegExp(glob) {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}
