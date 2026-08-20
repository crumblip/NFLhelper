import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Takes the em dashes out of text a reader actually sees.
 *
 * The em dash used as a dramatic pause is the single loudest tell of machine
 * written prose, and this codebase was full of them: 313 in rendered strings.
 * Ordinary English uses a comma, a colon or a full stop for the same job, and
 * picks between them based on what the two halves are doing.
 *
 * TWO THINGS THIS MUST NOT TOUCH.
 *
 * 1. **The em dash as a null placeholder.** Every table in this project prints
 *    a bare `—` where a value is missing, so `'—'`, `"—"` and `>—<` are data,
 *    not prose. Rewriting those would put a comma in every empty cell.
 * 2. **Comments.** 560 of them live in doc comments, which no reader sees. They
 *    are internal notes and are left alone; the instruction was about the text
 *    on screen.
 *
 * The rule for the rest: a following capital means two independent clauses, so
 * a full stop. Anything else is an aside or an apposition, so a comma. Paired
 * dashes around a phrase become paired commas, which is what they were always
 * standing in for.
 *
 * Run it, then read the result. It gets the mechanics right and cannot judge
 * rhythm, so the pages a reader spends time on still want an eye over them.
 */

const files = execSync('git ls-files "app/**/*.tsx" "app/**/*.ts" "lib/**/*.ts" "scripts/**/*.ts"', {
  encoding: 'utf8',
})
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => !f.endsWith('strip-emdash.ts'));

let changed = 0;
let touched = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let inBlockComment = false;
  let fileChanges = 0;

  const out = lines.map((line) => {
    const trimmed = line.trim();

    // Track block comments so their contents are never rewritten.
    const opens = (line.match(/\/\*/g) ?? []).length;
    const closes = (line.match(/\*\//g) ?? []).length;
    const startedInComment = inBlockComment;
    if (opens > closes) inBlockComment = true;
    else if (closes > opens) inBlockComment = false;

    if (startedInComment || trimmed.startsWith('*') || trimmed.startsWith('//')) return line;
    if (!line.includes('—')) return line;

    let next = line;

    // Page titles and headings: "Waiver wire — ChipShip" reads as a separator,
    // so it becomes one.
    next = next.replace(/ — (ChipShip)/g, ' · $1');

    // JSX line breaks: `above it —{' '}` keeps its spacing helper.
    next = next.replace(/ —(\{' '\})/g, ',$1');

    /*
     * The general case. A capital after the dash means a second independent
     * clause, which wants a full stop; anything else is an aside and wants a
     * comma. `'—'` as a placeholder has no spaces around it and never matches.
     */
    next = next.replace(/ — (?=\S)/g, (_m, ...args) => {
      const offset = args[args.length - 2] as number;
      const after = (args[args.length - 1] as string).slice(offset + 3);
      const firstWord = after.match(/^[A-Za-z]/)?.[0];
      return firstWord && firstWord === firstWord.toUpperCase() ? '. ' : ', ';
    });

    // A dash at end of line continuing onto the next is an aside break.
    next = next.replace(/ —$/g, ',');

    if (next !== line) fileChanges++;
    return next;
  });

  if (fileChanges > 0) {
    writeFileSync(file, out.join('\n'));
    changed += fileChanges;
    touched++;
    console.log(`  ${String(fileChanges).padStart(3)}  ${file}`);
  }
}

console.log(`\n${changed} lines rewritten across ${touched} files.`);
console.log('Placeholder dashes and comments were left alone. Read the pages before shipping.');
