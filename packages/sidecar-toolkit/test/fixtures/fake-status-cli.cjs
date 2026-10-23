#!/usr/bin/env node
// Fake report CLI for the status-source tests: prints, as JSON, the arguments it
// was given and the folder it ran in, the way a CLI that speaks JSON answers.
//
//   --exit <n>      exit with <n> after printing (a CLI reporting its own failure)
//   --text          print plain text instead of JSON
//   --stderr <msg>  write <msg> to stderr
const args = process.argv.slice(2);
const valueOf = flag => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
};
const stderr = valueOf('--stderr');
if (stderr) {
    process.stderr.write(`${stderr}\n`);
}
if (args.includes('--text')) {
    process.stdout.write('not json\n');
} else {
    process.stdout.write(JSON.stringify({ ok: !args.includes('--exit'), args, cwd: process.cwd() }));
}
process.exit(Number(valueOf('--exit') ?? 0));
