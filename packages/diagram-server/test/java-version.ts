import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * The major version of the Java the ELK server would be started with
 * (`$JAVA_HOME/bin/java`, else `java`, as ElkServerProcess picks it), or 0 when
 * there is none. The server's jar needs 17.
 */
export function javaMajor(): number {
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
    const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
    const match = /version "(\d+)(?:\.(\d+))?/.exec(`${result.stderr ?? ''}${result.stdout ?? ''}`);
    if (result.status !== 0 || !match) {
        return 0;
    }
    // "1.8.0" is Java 8.
    return match[1] === '1' ? Number(match[2]) : Number(match[1]);
}
