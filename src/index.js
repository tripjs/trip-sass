import _ from 'lodash';
import LazyBuilder from 'lazy-builder';
import micromatch from 'micromatch';
import path from 'path';
import Promise from 'bluebird';
import sander from 'sander';
import sass from 'node-sass';
import subdir from 'subdir';

let render;
const scssExt = /\.scss$/;
// const hasSassExtension = /\.s[ca]ss$/;

const defaults = {
  sourceMap: true,
  include: '**/*.scss',
};

const permittedOptions = [
  'indentType', 'indentWidth', 'linefeed', 'outputStyle',
  'precision', 'sourceComments', 'sourceMap',
];

export default function (options) {
  options = Object.assign({}, defaults, options);
  let sassOptions;

  const included = micromatch.filter(options.include);

  // normalise the loadPaths option
  if (!options.loadPaths) {
    if (options.loadPath) options.loadPaths = options.loadPath;
    else if (options.importPaths) options.loadPaths = options.importPaths;
  }
  if (options.loadPaths) {
    if (_.isString(options.loadPaths)) options.loadPaths = [options.loadPaths];
    else if (!Array.isArray(options.loadPaths) || !options.loadPaths.every(_.isString)) {
      throw new TypeError('trip-sass: Invalid "loadPaths" option');
    }

    options.loadPaths = options.loadPaths.map(loadPath => path.resolve(loadPath));
  }

  // return the build function
  return new LazyBuilder(function *tripSass(file, contents) {
    // skip irrelevant files
    if (!included(file)) return contents;

    // block partials
    if (path.basename(file).charAt(0) === '_') return null;

    // establish the output filename
    const outputFile = file.replace(scssExt, '') + '.css';

    // exit fast with a blank CSS file if the source SCSS file is blank
    // (necessitated by https://github.com/sass/node-sass/issues/924)
    const source = contents.toString();
    if (!source) return {[outputFile]: ''};

    // make a fake base for our relative files, just so everything's absolute, for simplicity
    const fakeBase = process.platform === 'win32' ? 'X:\\__TRIP_SASS__' : '/__TRIP_SASS__';
    const fakeEntryFile = path.resolve(fakeBase, file);

    // keep memos of how imports get resolved, in case we need this info to
    // report an error that originated from a partial :/
    const rememberedImportContents = {};
    const resolvedImportPaths = {stdin: fakeEntryFile};

    const builder = this;

    // establish options for node-sass
    const config = {
      data: source,

      importer: (arg, prev, done) => {
        // Resolve the import `arg`, load the contents (either locally or from a load path), and call the callback with it.
        // e.g. done({contents: result.contents.toString(), file: result.file});
        // or done(new Error(`trip-sass: Could not import "${url}" from ${path.dirname(importingFile)}`));

        Promise.coroutine(function *() {
          // establish which file the @import statement was encoutnered in
          const importer = (prev === 'stdin' ? fakeEntryFile : prev);
          console.assert(path.isAbsolute(importer), 'importing file should be absolute at this point');

          // establish where we're looking...
          const importerDirname = path.dirname(importer);
          const loadPaths = [importerDirname];
          if (options.loadPaths) for (const p of options.loadPaths) loadPaths.push(p);

          const argBasename = path.basename(arg);
          const argDirname = path.dirname(arg);

          // try each of the loadPaths (directories) in turn
          for (const loadPath of loadPaths) {
            // establish facts about the way it's been requested
            const hasUnderscore = argBasename.charAt(0) === '_';
            const hasSassExt = arg.endsWith('.sass');
            const hasScssExt = arg.endsWith('.scss');

            // make a list of candidates
            const candidates = [];
            if (!hasUnderscore) {
              if (hasSassExt || hasScssExt) candidates.push(path.join(argDirname, `_${argBasename}`), arg);
              else {
                candidates.push(
                  path.join(argDirname, `_${argBasename}.scss`),
                  path.join(argDirname, `_${argBasename}.sass`),
                  `${arg}.scss`,
                  `${arg}.sass`
                );
              }
            }
            else if (hasSassExt || hasScssExt) candidates.push(arg);
            else candidates.push(`${arg}.scss`, `${arg}.sass`);

            // convert to full paths and filter out those that don't exist
            const existingCandidates = yield Promise.map(candidates, candidate => {
              candidate = path.resolve(loadPath, candidate);

              // try to import it, either with this.importFile (if it's inside the imaginaryBase) or using a load path.
              // and return the {file, contents}
              // try to import it as an internal import if it's inside the fakeBase
              if (subdir(fakeBase, candidate)) {
                const contents = builder.importFile(path.relative(fakeBase, candidate));
                if (contents) return {contents: contents.toString(), file: candidate};
                return false;
              }

              // otherwise try to import it from disk
              return sander.readFile(candidate)
                .then(contents => {
                  return {contents: contents.toString(), file: candidate};
                })
                .catch(error => {
                  if (error.code !== 'ENOENT') throw error;
                  return false;
                });
            }).filter(x => x);

            // if nothing found, move onto the next load path
            if (existingCandidates.length === 0) continue;

            // if too many found, complain that it's ambiguous
            if (existingCandidates.length > 1) {
              throw new Error(`
                It's not clear which file to import for '@import "${arg}"' in file "${importer}".
                Candidates:
                ${existingCandidates.map(x => x.file).join('\n')}
                Please delete or rename all but one of these files.
              `);
            }

            // just one candidate
            console.assert(existingCandidates[0].hasOwnProperty('file') && existingCandidates[0].hasOwnProperty('contents'));
            return existingCandidates[0];
          }

          // can't find any suitable file.
          // send an error **back to sass**, which will send us back a new error
          // that includes file/line location of the offending @import statement.
          throw new Error(`File to import not found or unreadable: ${arg}`);
        })()
          .then(result => {
            // add it to the memos in case of errors loading a deeper import
            resolvedImportPaths[arg] = result.file;
            rememberedImportContents[result.file] = result.contents;

            done(result);
          })
          .catch(done);
      },
    };

    // add any user config
    if (!sassOptions) sassOptions = _.pick(options, permittedOptions);
    Object.assign(config, sassOptions);

    if (sassOptions.sourceMap) {
      sassOptions.sourceMap = true;
      sassOptions.outFile = path.resolve(outputFile);
    }

    // make a promise-returning sass-rendering function
    if (!render) render = Promise.promisify(sass.render);

    // compile!
    try {
      const result = yield render(config);

      return {
        [outputFile]: result.css,
        // [`${outputFile}.map`]: result.map, // TODO
      };
    }
    catch (error) {
      throw error; // TODO use CodeError (commented section below)

      // // establish the real file path where the error occurred
      // let realErrorFile = resolvedImportPaths[error.file];
      // if (realErrorFile) {
      //   if (subdir(fakeBase, error.file)) realErrorFile = path.relative(fakeBase, error.file);
      // }
      // else realErrorFile = `unknown(${error.file})`;

      // throw new CodeError({
      //   message: error.message.split('\n')[0],
      //   path: realErrorFile,
      //   contents: (error.file === 'stdin' ? source : rememberedImportContents[error.file]),
      //   line: error.line,
      //   column: error.column,
      // });
    }
  }).build;
}
