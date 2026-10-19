// Java 에이전트 빌드: Maven 없이 JDK 8의 javac와 jar로 에이전트 jar(Byte Buddy 포함)와 부트 jar(Tracer)를 만든다. 두 jar는 같은 폴더에 둔다.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const JAVA_HOME = process.env.APM_JAVA_HOME || 'D:/AnyBuilder/bin/java/jdk1.8.0_102-x64';
const REPO = 'D:/AnyBuilder/data/.tool/maven/repository';
const BYTEBUDDY = process.env.APM_BYTEBUDDY_JAR ||
  path.join(REPO, 'net/bytebuddy/byte-buddy/1.10.20/byte-buddy-1.10.20.jar');
// RequestAdvice가 쓰는 javax.servlet 타입 때문에 컴파일 때만 쓴다. jar에는 넣지 않는다.
const SERVLET = path.join(REPO, 'org/apache/tomcat/embed/tomcat-embed-core/9.0.43/tomcat-embed-core-9.0.43.jar');

const SRC = path.join(__dirname, 'src', 'apm');
const BUILD = path.join(__dirname, 'build');
const CLASSES = path.join(BUILD, 'classes');
const JAR = path.join(__dirname, 'dist', 'mini-apm-agent.jar');
const BOOT_JAR = path.join(__dirname, 'dist', 'mini-apm-boot.jar');

const javaBin = (name) => path.join(JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

function build() {
  for (const [what, p] of [['JDK (APM_JAVA_HOME)', javaBin('javac')], ['Byte Buddy (APM_BYTEBUDDY_JAR)', BYTEBUDDY], ['tomcat-embed-core', SERVLET]]) {
    if (!fs.existsSync(p)) throw new Error(`${what} 없음: ${p}`);
  }
  fs.rmSync(CLASSES, { recursive: true, force: true });
  fs.mkdirSync(CLASSES, { recursive: true });
  fs.mkdirSync(path.dirname(JAR), { recursive: true });

  const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.java')).map((f) => path.join(SRC, f));
  run(javaBin('javac'), ['-source', '8', '-target', '8', '-encoding', 'UTF-8', '-nowarn',
    '-cp', [BYTEBUDDY, SERVLET].join(path.delimiter), '-d', CLASSES, ...sources]);
  // Tracer는 부트스트랩 로더에 올린다(JDK의 HttpURLConnection 안에 들어간 계측 코드가 부르므로). 에이전트 jar에서는 뺀다.
  const apm = path.join(CLASSES, 'apm');
  const tracer = fs.readdirSync(apm).filter((f) => /^Tracer(\$.*)?\.class$/.test(f));
  run(javaBin('jar'), ['cf', BOOT_JAR, ...tracer.flatMap((f) => ['-C', CLASSES, `apm/${f}`])]);
  for (const f of tracer) fs.rmSync(path.join(apm, f));
  run(javaBin('jar'), ['xf', BYTEBUDDY], CLASSES);
  fs.rmSync(path.join(CLASSES, 'META-INF', 'MANIFEST.MF'), { force: true });

  const manifest = path.join(BUILD, 'MANIFEST.MF');
  fs.writeFileSync(manifest,
    `Premain-Class: apm.Agent\nCan-Retransform-Classes: true\nBoot-Class-Path: ${path.basename(BOOT_JAR)}\n`);
  run(javaBin('jar'), ['cfm', JAR, manifest, '-C', CLASSES, '.']);
  return JAR;
}

if (require.main === module) {
  try {
    console.log(build());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, javaBin, JAVA_HOME, REPO, JAR };
